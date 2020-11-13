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

import {promisify} from 'util';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import {amqpFactory, conversions, OPERATIONS, mongoFactory, PRIO_QUEUE_ITEM_STATE} from '@natlibfi/melinda-rest-api-commons';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import createSruClient from '@natlibfi/sru-client';
import httpStatus from 'http-status';

const setTimeoutPromise = promisify(setTimeout);

export default async function ({sruUrl, amqpUrl, mongoUri, pollWaitTime}) {
  const logger = createLogger();
  logger.log('debug', `Connecting prio to: ${amqpUrl} and ${mongoUri}`);
  const converter = conversions();
  const amqpOperator = await amqpFactory(amqpUrl);
  const mongoOperator = await mongoFactory(mongoUri);
  const sruClient = createSruClient({url: sruUrl, recordSchema: 'marcxml'});

  return {read, create, update};

  async function read({id, format}) {
    validateRequestId(id);
    logger.log('verbose', `Reading record ${id} from sru`);
    const record = await getRecord(id);

    if (record) {
      const serializedRecord = await converter.serialize(record, format);
      logger.log('silly', `Serialized record: ${JSON.stringify(serializedRecord)}`);
      return {record: serializedRecord};
    }

    throw new HttpError(httpStatus.NOT_FOUND, 'Record not found');
  }

  async function create({data, format, cataloger, oCatalogerIn, noop, unique, correlationId}) {
    logger.log('verbose', 'Sending a new record to queue');
    const operation = OPERATIONS.CREATE;
    const headers = {
      operation,
      format,
      cataloger,
      noop,
      unique
    };

    logger.log('verbose', `Creating Mongo queue item for correlationId ${correlationId}`);
    await mongoOperator.createPrio({correlationId, cataloger: cataloger.id, oCatalogerIn, operation});
    const responseData = await handleRequest();

    if (responseData.status === 'CREATED') {
      await mongoOperator.remove(correlationId);
      if (noop) {
        return responseData.messages;
      }

      return {messages: responseData.messages, id: responseData.payload};
    }

    throw new HttpError(responseData.status, responseData.payload || '');

    async function handleRequest() {
      // {queue, correlationId, headers, data}
      await amqpOperator.sendToQueue({queue: 'REQUESTS', correlationId, headers, data});

      logger.log('verbose', `Waiting response to id: ${correlationId}`);
      const message = await check(correlationId);
      const messageContent = JSON.parse(message.content.toString());
      const responseData = messageContent.data;

      logger.log('verbose', `Got response to id: ${correlationId}, status: ${responseData.status ? responseData.status : 'unexpected'}, payload: ${responseData.payload ? responseData.payload : 'undefined'}`);
      logger.log('silly', `Response data:\n${JSON.stringify(responseData)}`);

      // Ack message
      await amqpOperator.ackMessages([message]);
      await amqpOperator.removeQueue(correlationId);

      return responseData;
    }
  }


  async function update({id, data, format, cataloger, oCatalogerIn, noop, correlationId}) {
    validateRequestId(id);
    logger.log('info', `Creating updating task for record ${id}`);
    const operation = OPERATIONS.UPDATE;
    const headers = {
      operation,
      id,
      format,
      cataloger,
      noop
    };

    logger.log('verbose', `Creating Mongo queue item for record ${id}`);
    await mongoOperator.createPrio({correlationId, cataloger: cataloger.id, oCatalogerIn, operation});
    const responseData = await handleRequest();

    if (responseData.status === 'UPDATED') {
      await mongoOperator.remove(correlationId);

      if (noop) {
        return responseData.messages;
      }

      return responseData;
    }

    throw new HttpError(responseData.status, responseData.payload || '');

    async function handleRequest() {
      // {queue, correlationId, headers, data}
      logger.log('verbose', `Sending record ${id} to be validated. Correlation id ${correlationId}`);
      await amqpOperator.sendToQueue({queue: 'REQUESTS', correlationId, headers, data});

      logger.log('verbose', `Waiting response to correlation id: ${correlationId}`);
      const message = await check(correlationId);
      const messageContent = JSON.parse(message.content.toString());
      const responseData = messageContent.data;

      logger.log('verbose', `Got response to id: ${correlationId}, status: ${responseData.status ? responseData.status : 'unexpected'}, payload: ${responseData.payload ? responseData.payload : 'undefined'}`);
      logger.log('silly', `Response data:\n${JSON.stringify(responseData)}`);

      // Ack message
      amqpOperator.ackMessages([message]);
      amqpOperator.removeQueue(correlationId);

      return responseData;
    }
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
    logger.log('info', `Validating request ${id}`);
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

    const result = await mongoOperator.queryById(correlationId, true);

    if (queueItemState !== result.queueItemState) { // eslint-disable-line functional/no-conditional-statement
      logger.log('debug', `Queue item ${correlationId}, state ${result.queueItemState}`);
    }

    if (result.queueItemState === PRIO_QUEUE_ITEM_STATE.ABORT) { // eslint-disable-line functional/no-conditional-statement
      throw new HttpError(httpStatus.REQUEST_TIMEOUT, 'Request timeout, try again later');
    }

    // If DONE
    if (result.queueItemState === PRIO_QUEUE_ITEM_STATE.DONE || result.queueItemState === PRIO_QUEUE_ITEM_STATE.ERROR) {
      // Check queue
      const message = await amqpOperator.checkQueue(correlationId, 'raw', false);

      if (message) {
        return message;
      }

      return check(correlationId, result.queueItemState);
    }

    // Nothing in queue
    return check(correlationId, result.queueItemState, true);
  }
}
