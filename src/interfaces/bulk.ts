import type {Readable} from 'node:stream';
import httpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import {mongoFactory, amqpFactory, QUEUE_ITEM_STATE, OPERATIONS, CHUNK_SIZE} from '@natlibfi/melinda-rest-api-commons';
import {CONTENT_TYPES} from '../config.ts';
import {generateQuery, generateShowParams} from './utils.ts';
// import {inspect} from 'util';

/**
 * The operationSettings shape the bulk service hands to the validator:
 * the union of what create() builds and what the routes send.
 */
export interface OperationSettings {
  noStream?: boolean;
  noop?: boolean;
  unique?: boolean | null;
  merge?: boolean | null;
  validate?: boolean | null;
  skipLowValidation?: boolean | null;
  failOnError?: boolean | null;
  skipNoChangeUpdates?: boolean;
  matchFailuresAsNew?: boolean | null;
  prio?: boolean;
  fixType?: string;
  // The commons operator types operationSettings as Record<string, unknown>,
  // so allow extra settings without losing the typed fields above.
  [key: string]: unknown;
}

/**
 * Flat view of the request query string as accepted by validateQueryParams.
 * The index signature lets the (latent-bug) property references below keep
 * resolving exactly as they did in the JS version.
 */
export interface BulkQueryParams {
  pOldNew?: string;
  pActiveLibrary?: string;
  noStream?: string;
  noop?: string;
  unique?: string;
  merge?: string;
  validate?: string;
  skipLowValidation?: string;
  failOnError?: string;
  skipNoChangeUpdates?: string;
  matchFailuresAsNew?: string;
  pRejectFile?: string;
  pLogFile?: string;
  pCatalogerIn?: string;
  status?: string;
  // Latent bug, kept as-is: validateAndGetOperationSettings reads this
  // misspelled property, not skipLowValidation.
  skipLowValidateLow?: string;
  [key: string]: string | undefined;
}

/**
 * The create-branch return of validateQueryParams (the updateState branch
 * returns {state} instead).
 */
export interface BulkCreateQueryResult {
  operation: string;
  recordLoadParams: {
    pActiveLibrary: string;
    pOldNew: string;
    pRejectFile: string | null;
    pLogFile: string | null;
    pCatalogerIn: string | null;
  };
  noStream: boolean;
  operationSettings: OperationSettings;
}

export default async function ({mongoUri, amqpUrl, allowedLibs}: {mongoUri: string, amqpUrl: string, allowedLibs: string[]}) {
  const logger = createLogger();
  const mongoOperator = await mongoFactory(mongoUri, 'bulk');
  const amqpOperator = await amqpFactory(amqpUrl, true);

  return {create, addRecord, addRecords, getState, updateState, doQuery, readContent, remove, removeContent, validateQueryParams, checkCataloger};

  async function create({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, operationSettings, stream}: {
    correlationId: string;
    cataloger: string;
    oCatalogerIn: string;
    operation: string;
    contentType: string;
    recordLoadParams: BulkCreateQueryResult['recordLoadParams'];
    operationSettings: OperationSettings;
    stream?: Readable;
  }) {
    // commons 7 createBulk returns the normalized {correlationId, acknowledged,
    // queueItemState} result on both the noStream and stream paths
    const result = await mongoOperator.createBulk({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream, operationSettings});
    if (!stream) {
      logger.verbose(`NoStream bulk ready to receive records ${correlationId}!`);
      return result;
    }

    logger.verbose(`Stream uploaded for ${correlationId}!`);

    logger.silly(`Updating current state of ${correlationId} to ${QUEUE_ITEM_STATE.VALIDATOR.PENDING_QUEUING}`);
    const setStateResult = await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.VALIDATOR.PENDING_QUEUING});
    logger.silly(JSON.stringify(setStateResult));
    if (!setStateResult?.correlationId) {
      throw new HttpError(httpStatus.INTERNAL_SERVER_ERROR, `Could not update state for correlationId ${correlationId}. Result: ${JSON.stringify(setStateResult)}`);
    }
    return {correlationId, acknowledged: true, queueItemState: setStateResult.queueItemState};
  }

  // DEVELOP: syncronize addRecord and addRecords
  async function addRecord({correlationId, contentType, data}: {correlationId: string, contentType: string | undefined, data: unknown}) {

    // addBlobSize increases blobSize by 1 and returns the queueItem if there's a queueItem in state WAITING_FOR_RECORDS for correlationId
    const addBlobSizeResult = await mongoOperator.addBlobSize({correlationId});
    logger.silly(`addBlobSizeResult: ${JSON.stringify(addBlobSizeResult)}`);
    const queueItem = addBlobSizeResult;

    if (!queueItem) {
      throw new HttpError(httpStatus.NOT_FOUND, `Invalid queueItem ${correlationId} for adding records`);
    }

    if (data) {

      const type = contentType;
      const {conversionFormat} = (CONTENT_TYPES.find(({contentType, allowBulk}) => contentType === type && allowBulk === true)) as (typeof CONTENT_TYPES)[number];

      if (!conversionFormat) {
        throw new HttpError(httpStatus.UNSUPPORTED_MEDIA_TYPE, `Invalid content-type`);
      }

      const {operation, cataloger, operationSettings, blobSize} = queueItem;
      // a missing stored blobSize defaults to 0: under commons 5 the missing value
      // flowed through as undefined, but commons 7 rejects non-number blobSize with
      // 400, so the explicit default is required (same in addRecords below)
      const currentSequence = (blobSize ?? 0) + 1;
      const headers = {correlationId, operation, format: conversionFormat, cataloger, operationSettings, recordMetadata: {blobSequence: currentSequence}};

      logger.debug(`Adding record ${currentSequence} for ${correlationId}`);

      const queue = `${QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION}.${correlationId}`;
      await amqpOperator.sendToQueue({queue, correlationId, headers, data});

      return {status: httpStatus.CREATED, payload: `Record has been added to bulk ${correlationId} that has currently ${currentSequence} records`};
    }

    throw new HttpError(httpStatus.BAD_REQUEST, 'No record.');
  }

  // DEVELOP: syncronize addRecord and addRecords
  async function addRecords({correlationId, contentType, data}: {correlationId: string, contentType: string | undefined, data: string}) {

    if (!data) {
      throw new HttpError(httpStatus.BAD_REQUEST, 'No records.');
    }

    // get conversionFormat and check that we have contentType that can be handled - this might be a duplicate check?
    // NOTE: currently we handle just application/json for addRecords (array of marc-record-js)!
    // DEVELOP: handling MARCXML and marc21
    const conversionFormat = getConversionFormatForAddRecords(contentType);

    // get QueueItem and check that its in WAITING_FOR_RECORDS state
    const queueItem = await getQueueItemForAddRecords();
    const {operation, cataloger, operationSettings, blobSize} = queueItem;


    // parse data to an array
    // NOTE: this works just for application/json arrays of marc-record-js
    // DEVELOP: handle MARCXML, marc21 and alephSequential
    // DEVELOP: use splitter (toMarcRecords from melinda-rest-api-validator)
    // check that array size is not greater than CHUNK_SIZE

    const dataArray = parseDataAndCheckArray(data);
    const dataSize = dataArray.length;
    let currentSequence = blobSize ?? 0; // same missing-blobSize -> 0 default as in addRecord

    dataArray.forEach(async (record) => {
      currentSequence += 1;
      const headers = {correlationId, operation, format: conversionFormat, cataloger, operationSettings, recordMetadata: {blobSequence: currentSequence}};

      logger.debug(`Adding record ${currentSequence} for ${correlationId}`);

      const queue = `${QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION}.${correlationId}`;
      await amqpOperator.sendToQueue({queue, correlationId, headers, data: record});
    });

    const setBlobSizeResult = await mongoOperator.setBlobSize({correlationId, blobSize: currentSequence});
    logger.silly(`setBlobSizeResult: ${JSON.stringify(setBlobSizeResult)}`);

    return {status: httpStatus.CREATED, payload: `Records (${dataSize}) have been added to bulk ${correlationId} that has currently ${currentSequence} records`};

    function getConversionFormatForAddRecords(contentType: string | undefined) {
      logger.silly(`contentType: ${contentType}`);
      const type = contentType;
      const conversionFormatResult = CONTENT_TYPES.find(({contentType, allowAddRecords}) => contentType === type && allowAddRecords === true);
      logger.silly(`conversionFormatResult: ${JSON.stringify(conversionFormatResult)}`);
      if (!conversionFormatResult) {
        throw new HttpError(httpStatus.UNSUPPORTED_MEDIA_TYPE, `Invalid content-type`);
      }
      const conversionFormat = conversionFormatResult.conversionFormat;
      return conversionFormat;
    }

    async function getQueueItemForAddRecords() {
      logger.debug(`Getting current state of${correlationId}`);
      const queueItem = await mongoOperator.queryById({correlationId, checkModTime: false});
      logger.silly(`Result from query: ${JSON.stringify(queueItem)}`);

      if (!queueItem) {
        throw new HttpError(httpStatus.NOT_FOUND, `Invalid queueItem ${correlationId} for adding records`);
      }

      if (queueItem.queueItemState !== QUEUE_ITEM_STATE.VALIDATOR.WAITING_FOR_RECORDS) {
        throw new HttpError(httpStatus.BAD_REQUEST, `Invalid state (${queueItem.queueItemState}) for adding records in queueItem ${correlationId}`);
      }
      return queueItem;
    }

    function parseDataAndCheckArray(data: string) {
      const dataArray = parseData(data);
      if (Array.isArray(dataArray)) {
        // check that array size is not greater than CHUNK_SIZE
        const dataSize = dataArray.length;
        if (dataSize > CHUNK_SIZE) {
          throw new HttpError(httpStatus.BAD_REQUEST, `Too many (more than ${CHUNK_SIZE}) records (${dataSize})`);
        }
        return dataArray;
      }
      throw new HttpError(httpStatus.BAD_REQUEST, `Input is not a valid array of marc-record-js`);
    }

    function parseData(data: string) {
      try {
        logger.debug(`data: ${data}`);
        const dataArray = JSON.parse(data);
        logger.debug(`dataArray: ${JSON.stringify(dataArray)}`);
        return dataArray;
      } catch (error) {
        logger.debug(`Parsing data errored ${error}`);
        throw new HttpError(httpStatus.BAD_REQUEST, (error as Error).message);
      }

    }
  }


  async function getState(params: {correlationId: string}) {
    logger.debug(`Getting current state of ${params.correlationId}`);

    const result = await mongoOperator.query(params);
    logger.silly(`Result from query: ${JSON.stringify(result)}`);

    if (!result || result.length < 1) {
      throw new HttpError(httpStatus.NOT_FOUND, `Item not found for id: ${params.correlationId}`);
    }

    const item = result[0];

    if (item) {
      const {correlationId, queueItemState, modificationTime} = item;
      if (queueItemState && correlationId && modificationTime) {
        return {status: httpStatus.OK, payload: {correlationId, queueItemState, modificationTime}};
      }
    }

    throw new HttpError(httpStatus.NOT_FOUND, `Item not found for id: ${params.correlationId}`);
  }

  async function updateState({correlationId, state}: {correlationId: string, state: string}) {
    logger.debug(`Updating current state of ${correlationId} to ${state}`);
    const setStateResult = await mongoOperator.setState({correlationId, state});
    const value = setStateResult;
    if (value) {
      const {queueItemState, modificationTime} = value;
      return {status: httpStatus.OK, payload: {correlationId, queueItemState, modificationTime}};
    }

    throw new HttpError(httpStatus.NOT_FOUND, `Item not found for id: ${correlationId}`);
  }

  function readContent(correlationId?: string) {
    logger.debug(`Reading content for ${correlationId}`);
    if (correlationId) {
      return mongoOperator.readContent(correlationId);
    }

    // @ts-expect-error payload is omitted at runtime but typed as required by melinda-commons Error
    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  // oCatalogerIn is accepted for API compatibility only; commons 7 remove
  // takes the correlationId alone
  function remove({correlationId}: {oCatalogerIn: unknown, correlationId: string}) {

    if (correlationId) {
      // commons 7 remove returns {removed, deletedContent}; the route passes
      // the whole result through, oCatalogerIn is only for API compatibility
      const removeResult = mongoOperator.remove({correlationId});
      return removeResult;
    }

    // @ts-expect-error payload is omitted at runtime but typed as required by melinda-commons Error
    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  function removeContent({correlationId}: {oCatalogerIn: unknown, correlationId: string}) {
    if (correlationId) {
      // commons 7 removeContent returns false when no GridFS file exists;
      // the route ignores the value and always sends 204
      const removeContentResult = mongoOperator.removeContent({correlationId});
      return removeContentResult;
    }

    // @ts-expect-error payload is omitted at runtime but typed as required by melinda-commons Error
    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  async function doQuery(incomingParams: Record<string, string | undefined>) {
    const params = generateQuery(incomingParams);
    const showParams = generateShowParams(incomingParams);
    const {recordsAsReport, noRecords, noIds} = incomingParams;
    const report = recordsAsReport === undefined ? false : parseBoolean(recordsAsReport);
    const removeRecords = noRecords === undefined ? false : parseBoolean(noRecords);
    const removeIds = noIds === undefined ? false : parseBoolean(noIds);

    logger.debug(`Queue items querried with params: ${JSON.stringify(params)}, showParams: ${JSON.stringify(showParams)}`);

    const {id, correlationId, queueItemState, creationTime, modificationTime} = incomingParams;

    if (id || correlationId || queueItemState || creationTime || modificationTime) {
      const result = await mongoOperator.query(params, showParams);
      if (report || removeRecords || removeIds) {
        logger.debug(`Reducing recordItems to recordReport`);
        return result.map((queueItem: unknown) => createRecordReport({queueItem, report, removeRecords, removeIds}));
      }
      return result;
    }

    throw new HttpError(httpStatus.BAD_REQUEST, 'At least one filter parameter is required (id, correlationId, queueItemState, creationTime or modificationTime)');
  }

  function createRecordReport({queueItem, report = true, removeRecords = true, removeIds = true}: {queueItem: unknown, report?: boolean, removeRecords?: boolean, removeIds?: boolean}) {

    if (!report && !removeRecords && !removeIds) {
      logger.silly(`Returning queueItem as it is`);
      return queueItem;
    }

    const {records, handledIds, rejectedIds, ...rest} = queueItem as {records: unknown[], handledIds: unknown, rejectedIds: unknown} & Record<string, unknown>;
    logger.debug(`We have ${records.length} records to report`);

    if (!report) {
      if (removeRecords) {
        if (removeIds) {
          logger.silly(`Removing records and ids.`);
          return {...rest};
        }
        logger.silly(`Removing records.`);
        return {...rest, handledIds, rejectedIds};
      }

      logger.silly(`Removing ids.`);
      if (removeIds) {
        return {...rest, records};
      }
      logger.silly(`Returning queueItem as it is`);
      return queueItem;
    }

    logger.silly(`Creating record report`);
    const recordReport = {
      recordAmount: records.length,
      recordStatuses: reportRecordStatuses(records)
    };

    if (removeRecords) {
      if (removeIds) {
        logger.silly(`Returning report and removing records and ids`);
        return {...rest, recordReport};
      }
      logger.silly(`Returning report and removing records`);
      return {...rest, recordReport, handledIds, rejectedIds};
    }

    if (removeIds) {
      logger.silly(`Returning report and records, and removing ids`);
      return {...rest, recordReport, records};
    }
    logger.silly(`Returning report and queueItem as it is`);
    return {queueItem, recordReport};
  }

  function reportRecordStatuses(records: unknown[]) {
    const recordStatuses = records.reduce<Record<string, number>>((allStatuses, record) => {
      const recordStatus = (record as {recordStatus: string}).recordStatus;
      logger.silly(`Handling record: ${JSON.stringify(record)}`);
      logger.silly(`Current allStatuses: ${JSON.stringify(allStatuses)}`);

      if (recordStatus in allStatuses) {
        logger.silly(`We have an existing status: ${recordStatus}`);
        return {
          ...allStatuses,
          [recordStatus]: allStatuses[recordStatus]! + 1
        };
      }

      logger.silly(`We have a new status: ${recordStatus}`);
      return {
        ...allStatuses,
        [recordStatus]: 1
      };
    }, {});

    logger.silly(JSON.stringify(recordStatuses));
    return recordStatuses;
  }

  function validateQueryParams(queryParams: BulkQueryParams) {
    logger.silly(`bulk/validateQueryParams: queryParams: ${JSON.stringify(queryParams)}`);

    // Note: for backwards compatibility, if we have default empty allowedLibs, we do note check lib here (aleph-record-load-api handles it later)
    if (queryParams.pActiveLibrary && allowedLibs.length > 0 && !allowedLibs.includes(queryParams.pActiveLibrary)) {
      logger.debug(`Invalid pActiveLibrary parameter '${queryParams.pActiveLibrary} - not included in ${JSON.stringify(allowedLibs)}`);
      throw new HttpError(httpStatus.BAD_REQUEST, `Invalid pActiveLibrary parameter '${queryParams.pActiveLibrary}'`);
    }

    if (queryParams.pOldNew && queryParams.pActiveLibrary) {
      const {pOldNew} = queryParams;

      if (pOldNew !== 'NEW' && pOldNew !== 'OLD') {
        logger.debug(`bulk/validateQueryParams: invalid pOldNew: ${JSON.stringify(pOldNew)}`);
        throw new HttpError(httpStatus.BAD_REQUEST, `Invalid pOldNew query parameter '${pOldNew}'. (Valid values: OLD/NEW)`);
      }

      // DEVELOP: if we want to use FIX operation for bulk, we'll need to handle this choice differently
      const operation = pOldNew === 'NEW' ? OPERATIONS.CREATE : OPERATIONS.UPDATE;

      const recordLoadParams = {
        pActiveLibrary: queryParams.pActiveLibrary,
        pOldNew,
        pRejectFile: queryParams.pRejectFile || null,
        pLogFile: queryParams.pLogFile || null,
        pCatalogerIn: queryParams.pCatalogerIn || null
      };

      const noStream = queryParams.noStream ? parseBoolean(queryParams.noStream) : false;

      const operationSettings = validateAndGetOperationSettings(queryParams, noStream);
      logger.debug(`noStream: ${noStream}, operationSettings: ${JSON.stringify(operationSettings)}`);

      return {operation, recordLoadParams, noStream, operationSettings};
    }

    if (queryParams.status) {
      const validStates = ['PENDING_VALIDATION', 'DONE', 'ABORT'];

      if (validStates.includes(queryParams.status)) {
        return {state: queryParams.status};
      }

      throw new HttpError(httpStatus.BAD_REQUEST, 'Invalid status query parameter!');
    }

    logger.debug(`bulk/validateQueryParams: mandatory query param missing: pOldNew: ${JSON.stringify(queryParams.pOldNew)}, pActiveLibrary: ${JSON.stringify(queryParams.pActiveLibrary)}`);
    throw new HttpError(httpStatus.BAD_REQUEST, 'Missing one or more mandatory query parameters. (pActiveLibrary, pOldNew or status)');
  }

  function validateAndGetOperationSettings(queryParams: BulkQueryParams, noStream: boolean) {

    // NOTE: failOnError currently works on for splitting streamBulk stream to records, not for other validations
    // should these be in config.js ?

    logger.debug(`QueryParams for validating and getting operationSettings: ${JSON.stringify(queryParams)}`);

    const paramValidate = queryParams.validate ? parseBoolean(queryParams.validate) : undefined;
    const paramUnique = queryParams.unique ? parseBoolean(queryParams.unique) : undefined;
    const paramMerge = queryParams.merge ? parseBoolean(queryParams.merge) : undefined;
    const paramSkipLowValidation = queryParams.skipLowValidation ? parseBoolean(queryParams.skipLowValidateLow) : undefined;
    const paramMatchFailuresAsNew = queryParams.matchFailuresAsNew ? parseBoolean(queryParams.matchFailuresAsNew) : undefined;

    if (paramValidate === false && (paramUnique || paramMerge)) {
      logger.debug(`Query parameter validate=0 is not valid with query parameters unique=1 and/or merge=1`);
      throw new HttpError(httpStatus.BAD_REQUEST, `Query parameter validate=0 is not valid with query parameters unique=1 and/or merge=1`);
    }

    if (paramUnique === false && paramMerge) {
      logger.debug(`Query parameter unique=0 is not valid with query parameter merge=1`);
      throw new HttpError(httpStatus.BAD_REQUEST, `Query parameter unique=0 is not valid with query parameter merge=1`);
    }

    // noStream == batchBulk:   validate & unique are as default true
    // !noStream == streamBulk: validate & unique are as default false

    const operationSettings: OperationSettings = {
      noStream,
      noop: queryParams.noop === undefined ? false : parseBoolean(queryParams.noop),
      unique: paramUnique === undefined ? noStream : paramUnique,
      merge: paramMerge === undefined ? false : paramMerge,
      validate: paramValidate === undefined ? noStream : paramValidate,
      // Note: currently bulk skips LOW validation all the time, because cataloger.authorization is not forwarded in bulk
      skipLowValidation: paramSkipLowValidation === undefined ? false : paramSkipLowValidation,
      failOnError: queryParams.failOnError === undefined ? false : parseBoolean(queryParams.failOnError),
      // bulk skips changes that won't change the database record as default
      skipNoChangeUpdates: queryParams.skipNoChangeUpdates === undefined ? true : parseBoolean(queryParams.skipNoChangeUpdates),
      matchFailuresAsNew: paramMatchFailuresAsNew,
      prio: false
    };

    return operationSettings;
  }

  function checkCataloger(id: string, paramsId: string | undefined) {
    if (paramsId !== undefined && paramsId !== 'undefined' && paramsId !== '0' && paramsId !== 'false') {
      logger.debug(`Using cataloger given in parameters.`);
      return paramsId;
    }
    logger.debug(`No cataloger given in parameters, using user's id as cataloger.`);
    return id;
  }
}
