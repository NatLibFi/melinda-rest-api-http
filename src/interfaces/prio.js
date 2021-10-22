/* eslint-disable max-lines */
/* eslint-disable max-statements */
/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* RESTful API for Melinda
*
* Copyright (C) 2018-2019 University Of Helsinki (The National Library Of Finland)
*
* This file is part of melinda-rest-api-http
*
* melinda-rest-api-http program is free software: you can redistribute it and/or modify
* it under the terms of the GNU Affero General Public License as
* published by the Free Software Foundation, either version 3 of the
* License, or (at your option) any later version.
*
* melinda-rest-api-http is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU Affero General Public License for more details.
*
* You should have received a copy of the GNU Affero General Public License
* along with this program.  If not, see <http://www.gnu.org/licenses/>.
*
* @licend  The above is the entire license notice
* for the JavaScript code in this file.
*
*/

import {promisify, inspect} from 'util';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import {amqpFactory, conversions, OPERATIONS, mongoFactory, QUEUE_ITEM_STATE} from '@natlibfi/melinda-rest-api-commons';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import createSruClient from '@natlibfi/sru-client';
import httpStatus from 'http-status';
import sanitize from 'mongo-sanitize';

const setTimeoutPromise = promisify(setTimeout);

export default async function ({sruUrl, amqpUrl, mongoUri, pollWaitTime}) {
  const logger = createLogger();
  logger.debug(`Connecting prio to: ${amqpUrl} and ${mongoUri}`);
  const converter = conversions();
  const amqpOperator = await amqpFactory(amqpUrl);
  const mongoOperator = await mongoFactory(mongoUri, 'prio');
  const sruClient = createSruClient({url: sruUrl, recordSchema: 'marcxml'});

  return {read, create, update, doQuery};

  async function read({id, format}) {
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

  async function create({data, format, cataloger, oCatalogerIn, noop, unique, correlationId}) {
    logger.info(`Creating CREATE task for a new record ${correlationId}`);
    logger.verbose('Sending a new record to queue');
    const operation = OPERATIONS.CREATE;
    const headers = {
      operation,
      format,
      cataloger,
      noop,
      unique
    };

    logger.verbose(`Creating Mongo queue item for correlationId ${correlationId}`);
    await mongoOperator.createPrio({correlationId, cataloger: cataloger.id, oCatalogerIn, operation, noop, unique, prio: true});
    const responseData = await handleRequest({correlationId, headers, data});
    logger.debug(`prio/create response from handleRequest: ${inspect(responseData, {colors: true, maxArrayLength: 3, depth: 1})}}`);

    // Should handle cases where operation was changed by validator

    if (responseData.status === 'CREATED') {
      // If we want to retain data also for prio in mongo do not remove mongo item here
      await mongoOperator.remove({correlationId});
      if (noop) {
        return {messages: responseData.messages, id: undefined};
      }

      return {messages: responseData.messages, id: responseData.payload};
    }

    // Currently errors if validator changed the operation (CREATE -> UPDATE)
    throw new HttpError(responseData.status, responseData.payload || '');
  }


  async function update({id, data, format, cataloger, oCatalogerIn, noop, correlationId}) {
    validateRequestId(id);
    logger.info(`Creating UPDATE task for record ${id} / ${correlationId}`);
    const operation = OPERATIONS.UPDATE;
    const headers = {
      operation,
      id,
      format,
      cataloger,
      noop
    };

    logger.verbose(`Creating Mongo queue item for record ${id}`);

    await mongoOperator.createPrio({correlationId, cataloger: cataloger.id, oCatalogerIn, operation, noop, prio: true});
    const responseData = await handleRequest({correlationId, headers, data});
    logger.debug(`prio/update response from handleRequest: ${inspect(responseData, {colors: true, maxArrayLength: 3, depth: 1})}}`);

    // Should recognise cases where validator changed operation (more probable case is of course CREATE -> UPDATE)
    if (responseData.status === 'UPDATED') {
      await mongoOperator.remove({correlationId});

      if (noop) {
        return responseData.messages;
      }

      return responseData;
    }

    // Note: if validator changed the operation -> this errors currently
    throw new HttpError(responseData.status, responseData.payload || '');
  }

  async function handleRequest({correlationId, headers, data}) {
    logger.silly(`interfaces/prio/create/handleRequest`);
    // {queue, correlationId, headers, data}
    await amqpOperator.sendToQueue({queue: 'REQUESTS', correlationId, headers, data});

    logger.verbose(`interfaces/prio/create/handleRequest: Waiting response to id: ${correlationId}`);
    const responseData = await check(correlationId);

    // We get responseData from check

    logger.verbose(`Got response to id: ${correlationId}, status: ${responseData.status}, payload: ${responseData.payload}, messages: ${responseData.messages}`);
    logger.debug(`interfaces/prio/create/handleRequest: Response data: ${inspect(responseData, {colors: true, maxArrayLength: 3, depth: 1})}`);

    // Ack message was in check

    amqpOperator.removeQueue(correlationId);

    return responseData;
  }

  function getRecord(id) {
    return new Promise((resolve, reject) => {
      let promise; // eslint-disable-line functional/no-let

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

  function validateRequestId(id) {
    logger.debug(`Validating requestId ${id}`);
    // This should also check that id has only numbers
    if (id.length === 9) {
      return;
    }
    throw new HttpError(httpStatus.BAD_REQUEST, `Invalid request id ${id}`);
  }

  // Loop
  async function check(correlationId, queueItemState = '', wait = false) {
    if (wait) {
      await setTimeoutPromise(pollWaitTime);
      return check(correlationId, queueItemState);
    }

    // Check status and and also if process has timeouted
    // Note: there can be timeout result and the create/update to Melinda can still be done, if timeout happens when while job is being imported
    const result = await mongoOperator.queryById(correlationId, true);

    if (queueItemState !== result.queueItemState) { // eslint-disable-line functional/no-conditional-statement
      logger.debug(`Queue item ${correlationId}, state ${result.queueItemState}`);
    }

    // If ABORT -> Timeout
    // Does not read responses from queue:correlationId
    if (result.queueItemState === QUEUE_ITEM_STATE.ABORT) { // eslint-disable-line functional/no-conditional-statement
      logger.debug(`Queue item ${correlationId}, state ${result.queueItemState} - Timeout!`);
      const errorMessage = result.errorMessage || 'Request timeout, try again later';
      throw new HttpError(httpStatus.REQUEST_TIMEOUT, errorMessage);
    }

    if (result.queueItemState === QUEUE_ITEM_STATE.DONE || result.queueItemState === QUEUE_ITEM_STATE.ERROR) {
      return getResponseDataForDoneNError(result);
    }

    // queueItem state not DONE/ERROR/ABORT - loop back to check status
    return check(correlationId, result.queueItemState, true);
  }

  // async
  function getResponseDataForDoneNError(result) {

    logger.debug(`Mongo Result: ${JSON.stringify(result)}`);
    const correlationId = result.correlationId || '';
    const {noop} = result.operationSettings;

    // Get responseData from queue for validator errors/messages for noop operations
    // messageContent: {"data":{"status":409,"payload":["000503874"]}}
    // This should be removed?

    /*
    const message = await amqpOperator.checkQueue(correlationId, 'raw', false);
    logger.silly(`interfaces/prio/check message ${JSON.stringify(message)}`);

    // This has currently responses for noop from validator
    if (message) {
      const messageContent = JSON.parse(message.content.toString());
      logger.silly(`Got messageContent: ${JSON.stringify(messageContent)}`);
      const responseData = messageContent.data;
      logger.silly(`Got responseData: ${JSON.stringify(responseData)}`);
      logger.debug(`interfaces/prio/check Got response to id: ${correlationId}, status: ${responseData.status ? responseData.status : 'unexpected'}, payload: ${responseData.payload ? responseData.payload : 'undefined'}`);

      await amqpOperator.ackMessages([message]);
      return responseData;
    }
    */

    // Create responseData for those errors that didn't sendErrorResponse through queue
    logger.debug(`No message in queue ${correlationId}, responding based on the queueItem`);
    logger.debug(`${result}`);


    // ResponseData for ERRORs
    if (result.queueItemState === QUEUE_ITEM_STATE.ERROR) {
      logger.debug(`QueueItemState is ERROR, errorStatus: ${result.errorStatus} errorMessage: ${result.errorMessage}`);
      const errorStatus = result.errorStatus || httpStatus.INTERNAL_SERVER_ERROR;
      const responsePayload = result.errorMessage || 'unknown error';

      return {status: errorStatus, payload: responsePayload};
    }

    // ResponseData for non-ERROR noops
    if (noop) {
      logger.debug(`QueueItem is noop!`);
      const noopOperationStatus = result.operation === OPERATIONS.CREATE ? 'CREATED' : 'UPDATED';
      const noopMessages = result.noopValidationMessages[0].messages;
      return {status: noopOperationStatus, messages: noopMessages, payload: ''};
    }

    // ResponseData for non-ERROR non-noops
    const handledIds = result.handledIds ? result.handledIds : [];
    const rejectedIds = result.rejectedIds ? result.rejectedIds : [];

    if (handledIds.length < 1) {
      logger.debug(`Got 0 valid ids and rejected ${rejectedIds.length} ids: ${rejectedIds}`);

      const responseStatus = httpStatus.UNPROCESSABLE_ENTITY;
      const responsePayload = rejectedIds[0] || '';
      return {status: responseStatus, payload: responsePayload};
    }

    const operationStatus = result.operation === OPERATIONS.CREATE ? 'CREATED' : 'UPDATED';
    const responseStatus = operationStatus || 'unknown';
    logger.silly(`responseStatus ${JSON.stringify(responseStatus)}`);

    const responsePayload = handledIds[0] || '';
    logger.silly(`responsePayload ${JSON.stringify(responsePayload)}`);

    return {status: responseStatus, payload: responsePayload || ''};
  }

  function doQuery({query}) {
    // Query filters oCatalogerIn, correlationId, operation
    // Note currently only id works!
    // (id = correlationId)
    const clean = query.id ? sanitize(query.id) : {$ne: null};

    const params = {
      correlationId: clean
    };

    logger.debug(`Queue items querried with params: ${JSON.stringify(params)}`);

    if (params) {
      return mongoOperator.query(params);
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }
}
