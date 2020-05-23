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
import {Error as HttpError, Utils} from '@natlibfi/melinda-commons';
import {amqpFactory, conversions, OPERATIONS, mongoFactory, PRIO_QUEUE_ITEM_STATE} from '@natlibfi/melinda-rest-api-commons';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import createSruClient from '@natlibfi/sru-client';
import httpStatus from 'http-status';

const setTimeoutPromise = promisify(setTimeout);

export default async function ({sruBibUrl, amqpUrl, mongoUri, pollWaitTime}) {
  const {createLogger, toAlephId} = Utils;
  const logger = createLogger();
  logger.log('debug', `Connecting prio to: ${amqpUrl} and ${mongoUri}`);
  const converter = conversions();
  const amqpOperator = await amqpFactory(amqpUrl);
  const mongoOperator = await mongoFactory(mongoUri);
  const sruClient = createSruClient({serverUrl: sruBibUrl, version: '2.0', maximumRecords: '1'});
  const sruSubClient = createSruClient({serverUrl: sruBibUrl, version: '2.0'});

  return {read, create, update};

  async function read({id, format, subrecords}) {
    validateRequestId(id);
    logger.log('verbose', subrecords ? `Reading record ${id} and subrecords from sru` : `Reading record ${id} from sru`);
    const record = await getRecord(id);

    if (record) {
      if (subrecords) {
        const unserializedSubRecords = await getSubRecords(id);
        logger.log('debug', JSON.stringify(unserializedSubRecords));
        if (unserializedSubRecords) {
          const serializedSubRecords = unserializedSubRecords.map(record => converter(record, format));
          return {record: converter.serialize(record, format), childRecords: serializedSubRecords};
        }
        return {record: converter.serialize(record, format), childRecords: []};
      }

      return {record: converter.serialize(record, format)};
    }

    throw new HttpError(httpStatus.NOT_FOUND, 'Record not found');
  }

  async function create({data, format, cataloger, noop, unique, correlationId}) {
    logger.log('verbose', 'Sending a new record to queue');
    const operation = OPERATIONS.CREATE;
    const headers = {
      operation,
      format,
      cataloger,
      noop,
      unique
    };

    await mongoOperator.createPrio({correlationId, cataloger: cataloger.id, operation});
    // {queue, correlationId, headers, data}
    await amqpOperator.sendToQueue({queue: 'REQUESTS', correlationId, headers, data});

    logger.log('verbose', `Waiting response to id: ${correlationId}`);
    const message = await check(correlationId);
    const messageContent = JSON.parse(message.content.toString());
    const responseData = messageContent.data;

    logger.log('verbose', `Got response to id: ${correlationId} status: ${responseData.status ? responseData.status : 'unexpected'}, id: ${responseData.payload ? responseData.payload : 'undefined'}`);
    logger.log('silly', `Response data:\n${JSON.stringify(responseData)}`);

    // Ack message
    await amqpOperator.ackMessages([message]);
    await amqpOperator.removeQueue(correlationId);

    if (responseData.status === 'CREATED') {
      await mongoOperator.pushId({correlationId, id: responseData.payload || undefined});
      // Reply to http
      if (noop) {
        return responseData.messages;
      }
      return {messages: responseData.messages, id: responseData.payload};
    }


    throw new HttpError(responseData.status, responseData.payload || '');
  }

  async function update({id, data, format, cataloger, noop, correlationId}) {
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
    await mongoOperator.createPrio({correlationId, cataloger: cataloger.id, operation});
    // {queue, correlationId, headers, data}
    logger.log('verbose', `Sending record ${id} to be validated. Correlation id ${correlationId}`);
    await amqpOperator.sendToQueue({queue: 'REQUESTS', correlationId, headers, data});

    logger.log('verbose', `Waiting response to correlation id: ${correlationId}`);
    const message = await check(correlationId);
    const messageContent = JSON.parse(message.content.toString());
    const responseData = messageContent.data;

    logger.log('verbose', `Got response to id: ${correlationId}, status: ${responseData.status ? responseData.status : 'unexpected'}, id: ${responseData.payload ? responseData.payload : 'undefined'}`);
    logger.log('silly', `Response data:\n${JSON.stringify(responseData)}`);

    // Ack message
    await amqpOperator.ackMessages([message]);
    await amqpOperator.removeQueue(correlationId);

    if (responseData.status === 'UPDATED') {
      await mongoOperator.pushId({correlationId, id: responseData.payload || undefined});
      // Reply to http
      if (noop) {
        return responseData.messages;
      }
      return responseData;
    }

    throw new HttpError(responseData.status, responseData.payload || '');
  }

  function getRecord(id) {
    return new Promise((resolve, reject) => {
      sruClient.searchRetrieve(`rec.id=${id}`)
        .on('record', xmlString => {
          resolve(MARCXML.from(xmlString));
        })
        .on('end', () => resolve())
        .on('error', err => reject(err));
    });
  }

  function getSubRecords(id) {
    return new Promise((resolve, reject) => {
      sruSubClient.searchRetrieve(`melinda.partsofhost=${id}`)
        .on('record', xmlString => {
          resolve(MARCXML.from(xmlString));
        })
        .on('end', () => resolve())
        .on('error', err => reject(err));
    });
  }

  function validateRequestId(id) {
    logger.log('info', `Validating request ${id}`);
    if (id.length > 9) { // eslint-disable-line functional/no-conditional-statement
      throw new HttpError(httpStatus.BAD_REQUEST, `Invalid request id ${id}`);
    }
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
      throw new HttpError(408, 'Request timeout, try again later');
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
