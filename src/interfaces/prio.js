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
import {amqpFactory, conversions, OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import createSruClient from '@natlibfi/sru-client';

const setTimeoutPromise = promisify(setTimeout);
const {createLogger} = Utils;

export default async function ({sruBibUrl, amqpUrl, pollWaitTime}) {
  const logger = createLogger();
  const converter = conversions();
  const amqpOperator = await amqpFactory(amqpUrl);
  const sruClient = createSruClient({serverUrl: sruBibUrl, version: '2.0', maximumRecords: '1'});

  return {read, create, update};

  async function read({id, format}) {
    logger.log('debug', `Reading record ${id} from datastore`);
    const record = await getRecord(id);
    logger.log('debug', `Serializing record ${id}`);
    return converter.serialize(record, format);
  }

  async function create({data, format, cataloger, noop, unique, correlationId}) {
    logger.log('debug', 'Sending a new record to queue');
    const headers = {
      operation: OPERATIONS.CREATE,
      format,
      cataloger,
      noop,
      unique
    };

    // {queue, correlationId, headers, data}
    await amqpOperator.sendToQueue({queue: 'REQUESTS', correlationId, headers, data});

    logger.log('debug', `Waiting response to id: ${correlationId}`);
    const response = await check(correlationId);
    const content = JSON.parse(response.content.toString());
    const responseData = content.data;

    logger.log('debug', `Got response to id: ${correlationId}`);
    logger.log('debug', 'Response data:');
    logger.log('debug', JSON.stringify(responseData, null, '\t'));

    // Ack message
    amqpOperator.ackMessages([response]);
    amqpOperator.removeQueue(correlationId);

    if (responseData.status === 'CREATED') {
      // Reply to http
      return responseData;
    }

    throw new HttpError(responseData.status, responseData.payload || '');
  }

  async function update({id, data, format, cataloger, noop, correlationId}) {
    logger.log('debug', `Sending updating task for record ${id} to queue`);
    const headers = {
      operation: OPERATIONS.UPDATE,
      id,
      format,
      cataloger,
      noop
    };

    // {queue, correlationId, headers, data}
    await amqpOperator.sendToQueue({queue: 'REQUESTS', correlationId, headers, data});

    logger.log('debug', `Waiting response to id: ${correlationId}`);
    const response = await check(correlationId);
    const content = JSON.parse(response.content.toString());
    const responseData = content.data;

    logger.log('debug', `Got response to id: ${correlationId}`);
    logger.log('debug', 'Response data:');
    logger.log('debug', JSON.stringify(responseData, null, '\t'));

    // Ack message
    await amqpOperator.ackMessages([response]);
    await amqpOperator.removeQueue(correlationId);

    if (responseData.status === 'UPDATED') {
      // Reply to http
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

  // Loop
  async function check(queue, tries = 0) {
    // Check queue
    const message = await amqpOperator.checkQueue(queue, 'raw', false);

    if (message) {
      return message;
    }

    // To close infinite loops
    if (tries + 1 > 1200) { // eslint-disable-line functional/no-conditional-statement
      throw new HttpError(408);
    }

    // Nothing in queue
    await setTimeoutPromise(pollWaitTime);
    return check(queue, tries + 1);
  }
}
