import {promisify, inspect} from 'util';
import {createLogger} from '@natlibfi/melinda-commons';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import {amqpFactory, conversions, OPERATIONS, mongoFactory, QUEUE_ITEM_STATE} from '@natlibfi/melinda-rest-api-commons';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import createSruClient from '@natlibfi/sru-client';
import httpStatus from 'http-status';
import {generateQuery, generateShowParams} from './utils.ts';
import type {Cataloger} from '../routes/routeUtils.ts';
import type {OperationSettings} from './bulk.ts';

// Map validator recordStatus strings to HTTP status codes.
// When the validator flips the outcome (e.g. create → UPDATED because
// the record already exists and merge is off), the client requested a
// specific operation that could not be fulfilled — 409 CONFLICT.
// Passes through numeric values (e.g. ERROR leg already has a proper code).
function unexpectedRecordStatusToHttp(status: unknown) {
  if (typeof status === 'number') return status;
  switch (status) {
    case 'INVALID':
      return httpStatus.BAD_REQUEST;
    case 'UPDATED':
    case 'SKIPPED':
    case 'CREATED':
    case 'FIXED':
      return httpStatus.CONFLICT;
    default:
      return httpStatus.CONFLICT;
  }
}

const setTimeoutPromise = promisify(setTimeout);

/**
 * The Mongo queueItem result objects the poll loop and response builders
 * read. Fields are untyped on purpose: they come from the untyped Mongo
 * operator and only the accessed shape matters here.
 */
interface QueueItemResult {
  correlationId?: unknown;
  queueItemState?: string;
  errorMessage?: unknown;
  errorStatus?: number;
  records?: {recordStatus?: unknown, databaseId?: string}[];
}

/**
 * The response item the poll loop resolves with. `payload` is the
 * validator's recordResponseItem (or the error payload) - unstructured
 * data; `databaseId` is the only field this service reads. `undefined`
 * payload is possible for empty record lists; the original code then
 * throws on its `payload.databaseId` accesses, and the casts below keep
 * that behavior.
 */
interface PrioResponseData {
  status: unknown;
  payload: ({databaseId?: string} & Record<string, unknown>) | undefined;
}

export default async function ({sruUrl, amqpUrl, mongoUri, pollWaitTime}: {sruUrl: string, amqpUrl: string, mongoUri: string, pollWaitTime: number}) {
  const logger = createLogger();
  logger.debug(`Connecting prio to: ${amqpUrl} and ${mongoUri}`);
  const converter = conversions();
  const amqpOperator = await amqpFactory(amqpUrl, true);
  const mongoOperator = await mongoFactory(mongoUri, 'prio');
  const sruClient = createSruClient({url: sruUrl, recordSchema: 'marcxml'});

  return {read, create, update, fix, doQuery};

  async function read({id, format}: {id: string, format: string}) {
    logger.info(`Reading record ${id} / ${format}`);
    validateRequestId(id);
    logger.verbose(`Reading record ${id} from sru`);
    const record = await getRecord(id);

    if (record) {
      const serializedRecord = await converter.serialize(record, format);
      logger.silly(`Serialized record: ${JSON.stringify(serializedRecord)}`);
      return {record: serializedRecord};
    }

    throw new HttpError(httpStatus.NOT_FOUND, 'Record not found');
  }

  async function create({data, format, cataloger, oCatalogerIn, operationSettings, correlationId}: {
    data: unknown;
    format: string;
    cataloger: Cataloger;
    oCatalogerIn: string;
    operationSettings: OperationSettings;
    correlationId: string;
  }) {
    logger.info(`Creating CREATE task for a new record ${correlationId}`);
    logger.verbose('Sending a new record to queue');
    const operation = OPERATIONS.CREATE;
    const headers = {
      correlationId,
      operation,
      format,
      cataloger,
      operationSettings
    };

    logger.verbose(`Creating Mongo queue item for correlationId ${correlationId}`);
    await mongoOperator.createPrio({correlationId, cataloger: cataloger.id, oCatalogerIn, operation, operationSettings});

    // handleRequest returns recordResponseItem as respenseData

    const responseData = await handleRequest({correlationId, headers, data});
    const {status, payload} = responseData;

    logger.silly(`prio/create response from handleRequest: ${inspect(responseData, {colors: true, maxArrayLength: 3, depth: 1})}}`);
    logger.debug(`status: ${status}, ${payload!.databaseId}, ${JSON.stringify(payload)}`);

    cleanMongo(correlationId);

    if (status === 'CREATED' || (operationSettings.merge && (status === 'UPDATED' || status === 'SKIPPED'))) {
      return {messages: payload, id: payload!.databaseId, status};
    }

    throw new HttpError(unexpectedRecordStatusToHttp(status), payload || '');
  }


  async function update({id, data, format, cataloger, oCatalogerIn, operationSettings, correlationId}: {
    id: string;
    data: unknown;
    format: string;
    cataloger: Cataloger;
    oCatalogerIn: string;
    operationSettings: OperationSettings;
    correlationId: string;
  }) {
    validateRequestId(id);
    logger.info(`Creating UPDATE task for record ${id} / ${correlationId}`);
    const operation = OPERATIONS.UPDATE;
    const headers = {
      correlationId,
      operation,
      id,
      format,
      cataloger,
      operationSettings
    };

    logger.verbose(`Creating Mongo queue item for record ${id} / ${correlationId}`);

    await mongoOperator.createPrio({correlationId, cataloger: cataloger.id, oCatalogerIn, operation, operationSettings});
    const responseData = await handleRequest({correlationId, headers, data});
    const {status, payload} = responseData;

    logger.silly(`prio/update response from handleRequest: ${inspect(responseData, {colors: true, maxArrayLength: 3, depth: 1})}}`);
    logger.debug(`status: ${status}, ${payload}`);

    cleanMongo(correlationId);

    // Should recognise cases where validator changed operation (more probable case is of course CREATE -> UPDATE)
    if (status === 'UPDATED' || status === 'SKIPPED') {
      return {status, messages: payload, id: payload!.databaseId};
    }

    // Note: if validator changed the operation -> this errors currently
    throw new HttpError(unexpectedRecordStatusToHttp(status), payload || '');
  }


  async function fix({id, cataloger, oCatalogerIn, operationSettings, correlationId}: {
    id: string;
    cataloger: Cataloger;
    oCatalogerIn: string;
    operationSettings: OperationSettings;
    correlationId: string;
  }) {
    validateRequestId(id);
    logger.info(`Creating FIX (${operationSettings.fixType}) task for record ${id} / ${correlationId}`);
    const operation = OPERATIONS.FIX;
    logger.debug(`operation: ${operation}`);
    const headers = {
      correlationId,
      operation,
      id,
      cataloger,
      operationSettings
    };

    logger.verbose(`Creating Mongo queue item for fixing record ${id} / ${correlationId}`);

    await mongoOperator.createPrio({correlationId, cataloger: cataloger.id, oCatalogerIn, operation, operationSettings});
    const responseData = await handleRequest({correlationId, headers, data: {}});
    const {status, payload} = responseData;

    logger.silly(`prio/fix response from handleRequest: ${inspect(responseData, {colors: true, maxArrayLength: 3, depth: 1})}}`);
    logger.debug(`status: ${status}, ${payload}`);

    cleanMongo(correlationId);

    // Should recognise cases where validator changed operation (more probable case is of course CREATE -> UPDATE)
    if (status === 'FIXED' || status === 'SKIPPED') {
      return {status, messages: payload, id: payload!.databaseId};
    }

    // Note: if validator changed the operation -> this errors currently
    throw new HttpError(unexpectedRecordStatusToHttp(status), payload || '');
  }


  // cleanMongo cleans the actual MongoCollection ('prio'), logCollection ('logPrio') retains all items
  async function cleanMongo(correlationId: string) {
    const result = (await mongoOperator.queryById({correlationId, checkModTime: true})) as QueueItemResult;
    logger.silly(` ${inspect(result, {colors: true, maxArrayLength: 3, depth: 1})}}`);

    // These could be configurable
    // logCollection holds the queueItem -> this could remove also non-409 -ERRORs and ABORTs

    if (result.queueItemState === 'DONE') {
      logger.debug(`queueItemState: DONE, removing prio queueItem for ${correlationId}`);
      mongoOperator.remove({correlationId});
      return;
    }

    if (result.queueItemState === 'ERROR' && result.errorStatus === httpStatus.CONFLICT) {
      logger.debug(`queueItemState: ERROR, errorStatus: CONFLICT, removing prio queueItem for ${correlationId}`);
      mongoOperator.remove({correlationId});
      return;
    }
  }

  async function handleRequest({correlationId, headers, data}: {correlationId: string, headers: Record<string, unknown>, data: unknown}): Promise<PrioResponseData> {
    logger.silly(`interfaces/prio/create/handleRequest`);
    // {queue, correlationId, headers, data}
    await amqpOperator.sendToQueue({queue: 'REQUESTS', correlationId, headers, data});

    logger.verbose(`interfaces/prio/create/handleRequest: Waiting response to id: ${correlationId}`);
    const responseData = await check(correlationId);

    // We get responseData (recordResponseItem of ??? for errors) from check

    logger.verbose(`Got response to id: ${correlationId}, status: ${responseData.status}, payload: ${responseData.payload}`);
    logger.silly(`interfaces/prio/create/handleRequest: Response data: ${inspect(responseData, {colors: true, maxArrayLength: 3, depth: 1})}`);
    // Ack message was in check

    return responseData;
  }

  function getRecord(id: string) {
    return new Promise((resolve: (value?: unknown) => void, reject: (reason?: unknown) => void) => {
      let promise: Promise<unknown> | undefined;

      sruClient.searchRetrieve(`rec.id=${id}`)
        .on('record', xmlString => {
          promise = MARCXML.from(xmlString, {subfieldValues: false});
        })
        .on('end', async () => {
          if (promise) {
            try {
              const record = await promise;
              resolve(record);
            } catch (err) {
              reject(err);
            }

            return;
          }

          resolve();
        })
        .on('error', err => reject(err));
    });
  }

  function validateRequestId(id: string) {
    logger.debug(`Validating requestId ${id}`);

    if (id.length === 9 && (/^\d+$/u).test(id)) {
      return;
    }
    throw new HttpError(httpStatus.BAD_REQUEST, `Invalid request id ${id}`);
  }

  // Loop
  async function check(correlationId: string, queueItemState = '', wait = false) {
    if (wait) {
      await setTimeoutPromise(pollWaitTime);
      return check(correlationId, queueItemState);
    }

    // Check status and and also if process has timeouted
    // Note: there can be timeout result and the create/update to Melinda can still be done, if timeout happens when while job is being imported
    const result = (await mongoOperator.queryById({correlationId, checkModTime: true})) as QueueItemResult;

    if (queueItemState !== result.queueItemState) {
      logger.debug(`Queue item ${correlationId}, state ${result.queueItemState}`);
    }

    // If ABORT -> Timeout
    if (result.queueItemState === QUEUE_ITEM_STATE.ABORT) {
      return getResponseDataForAbort(result);
    }

    if (result.queueItemState === QUEUE_ITEM_STATE.DONE || result.queueItemState === QUEUE_ITEM_STATE.ERROR) {
      return getResponseDataForDoneNError(result);
    }

    // queueItem state not DONE/ERROR/ABORT - loop back to check status
    return check(correlationId, result.queueItemState as string, true);
  }

  function getResponseDataForAbort(result: QueueItemResult): never {
    logger.debug(`Queue item ${result.correlationId}, state ${result.queueItemState} - Timeout!`);
    const errorMessage = result.errorMessage || 'Request timeout, try again later';
    throw new HttpError(httpStatus.REQUEST_TIMEOUT, errorMessage);
  }

  // should we return also correlationId in prio?
  // async
  function getResponseDataForDoneNError(result: QueueItemResult) {

    logger.debug(`Mongo Result: ${JSON.stringify(result)}`);
    const correlationId = result.correlationId || '';

    logger.debug(`Responding for ${correlationId} based on the queueItem`);

    // ResponseData for ERRORs (noop & non-noop)
    if (result.queueItemState === QUEUE_ITEM_STATE.ERROR) {
      return getResponseDataForError(result);
    }

    // ResponseData for non-ERROR non-noops
    return getResponseDataForDone(result);
  }

  function getResponseDataForError(result: QueueItemResult) {

    const recordResponses = result.records ? result.records : [];
    // prio assumes we had only one record, so we send back just the first recordResponse
    // if we will later allow prio to have more than one record, this needs to be fixed
    const [firstRecordResponse] = recordResponses;
    logger.debug(`We have recordResponses (${recordResponses.length}): ${JSON.stringify(recordResponses)}`);
    logger.silly(`First recordResponse: ${JSON.stringify(firstRecordResponse)}`);

    logger.debug(`QueueItemState is ERROR, errorStatus: ${result.errorStatus} errorMessage: ${result.errorMessage}`);
    const errorStatus = result.errorStatus || httpStatus.INTERNAL_SERVER_ERROR;
    // @ts-expect-error object literal is always truthy so the || fallback is dead code (latent bug, kept as-is)
    const responsePayload = {message: result.errorMessage} || {message: 'unknown error'};
    const responsePayloadAndStatus = {...responsePayload, status: errorStatus};
    return {status: errorStatus, payload: firstRecordResponse || responsePayloadAndStatus};
  }

  function getResponseDataForDone(result: QueueItemResult) {

    const recordResponses = result.records ? result.records : [];
    const [firstRecordResponse] = recordResponses;
    logger.debug(`We have recordResponses (${recordResponses.length}): ${JSON.stringify(recordResponses)}`);
    logger.silly(`First recordResponse: ${JSON.stringify(firstRecordResponse)}`);
    const {recordStatus} = firstRecordResponse as {recordStatus?: unknown};
    // prio assumes we had only one record, so we send back just the first recordResponse
    // if we will later allow prio to have more than one record, this needs to be fixed
    return {status: recordStatus, payload: firstRecordResponse};
  }

  function doQuery(incomingParams: Record<string, string | undefined>) {
    const params = generateQuery(incomingParams);
    const showParams = generateShowParams(incomingParams);

    logger.debug(`Queue items querried with params: ${JSON.stringify(params)}`);

    if (params) {
      return mongoOperator.query(params, showParams);
    }

    // @ts-expect-error payload is omitted at runtime but typed as required by melinda-commons Error
    throw new HttpError(httpStatus.BAD_REQUEST);
  }
}
