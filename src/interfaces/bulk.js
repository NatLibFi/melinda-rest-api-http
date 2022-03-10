/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* RESTful API for Melinda
*
* Copyright (C) 2018-2019 University Of Helsinki (The National Library Of Finland)
*
* This file is part of melinda-rest-api-http
** melinda-rest-api-http program is free software: you can redistribute it and/or modify
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

import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import {mongoFactory, amqpFactory, QUEUE_ITEM_STATE, CONTENT_TYPES} from '@natlibfi/melinda-rest-api-commons';
import httpStatus from 'http-status';
import sanitize from 'mongo-sanitize';

export default async function ({mongoUri, amqpUrl}) {
  const logger = createLogger();
  const mongoOperator = await mongoFactory(mongoUri, 'bulk');
  const amqpOperator = await amqpFactory(amqpUrl);

  return {create, addRecord, getState, updateState, doQuery, readContent, remove, removeContent, validateQueryParams, checkCataloger};

  async function create({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream}) {
    const result = await mongoOperator.createBulk({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream, prio: false});
    if (!stream) {
      logger.verbose('NoStream bulk ready!');
      return result;
    }

    logger.verbose('Stream uploaded!');
    return mongoOperator.setState({correlationId, oCatalogerIn, operation, state: QUEUE_ITEM_STATE.VALIDATOR.PENDING_QUEUING});
  }

  async function addRecord({correlationId, contentType, record}) {
    // asses rabbit queue for correlationId
    if (record) {
      const headers = {format: CONTENT_TYPES.prio[contentType]};
      logger.debug('Got record');
      // Read record from stream using serializer
      logger.debug(`Record: ${JSON.stringify(record)}`);
      logger.debug(`Using ${contentType} stream reader for parsing record.`);
      logger.debug(`Adding record for ${correlationId}`);
      await amqpOperator.sendToQueue({queue: `${QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION}.${correlationId}`, correlationId, headers, data: record});

      await Promise.all([]);
      return {status: '202', payload: `Record have been added to bulk ${correlationId}`};
    }

    return {status: '400', payload: 'No record'};
  }

  async function getState(params) {
    logger.debug(`Getting current state of ${params.correlationId}`);
    const [{correlationId, queueItemState, modificationTime}] = await mongoOperator.query(params);
    if (queueItemState) {
      return {status: 200, payload: {correlationId, queueItemState, modificationTime}};
    }

    return {status: 404, payload: `Item not found for id: ${params.correlationId}`};
  }

  async function updateState({correlationId, state}) {
    logger.debug(`Updating current state of ${correlationId} to ${state}`);
    const {value} = await mongoOperator.setState({correlationId, state});
    if (value) {
      const {queueItemState, modificationTime} = value;
      return {status: 200, payload: {correlationId, queueItemState, modificationTime}};
    }

    return {status: 404, payload: `Item not found for id: ${correlationId}`};
  }

  function readContent(correlationId) {
    logger.debug(`Reading content for ${correlationId}`);
    if (correlationId) {
      return mongoOperator.readContent(correlationId);
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  function remove({oCatalogerIn, correlationId}) {
    if (correlationId) {
      return mongoOperator.remove({oCatalogerIn, correlationId});
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  function removeContent({oCatalogerIn, correlationId}) {
    if (correlationId) {
      return mongoOperator.removeContent({oCatalogerIn, correlationId});
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  function doQuery(incomingParams) {
    // Query filters oCatalogerIn, correlationId, operation
    // currently filters only by correlationId

    const {query} = incomingParams;
    const foundId = Boolean(query.id);
    const clean = foundId ? sanitize(query.id) : '';

    const params = {
      correlationId: foundId ? clean : {$ne: null}
    };

    logger.debug(`Queue items querried with params: ${JSON.stringify(params)}`);

    if (params) {
      return mongoOperator.query(params);
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  function validateQueryParams(queryParams) {

    logger.silly(`bulk/validateQueryParams: queryParams: ${JSON.stringify(queryParams)}`);
    if (queryParams.pOldNew && queryParams.pActiveLibrary) {
      const {pOldNew} = queryParams;

      if (pOldNew !== 'NEW' && pOldNew !== 'OLD') {
        logger.debug(`bulk/validateQueryParams: invalid pOldNew: ${JSON.stringify(pOldNew)}`);
        throw new HttpError(httpStatus.BAD_REQUEST, `Invalid pOldNew query parameter '${pOldNew}'. (Valid values: OLD/NEW)`);
      }

      const operation = pOldNew === 'NEW' ? 'CREATE' : 'UPDATE';
      const recordLoadParams = {
        pActiveLibrary: queryParams.pActiveLibrary,
        pOldNew,
        pRejectFile: queryParams.pRejectFile || null,
        pLogFile: queryParams.pLogFile || null,
        pCatalogerIn: queryParams.pCatalogerIn || null
      };

      const noStream = queryParams.noStream ? parseBoolean(queryParams.noStream) : false;
      // Req.params.operation.toUpperCase()
      return {operation, recordLoadParams, noStream};
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

  function checkCataloger(id, paramsId) {
    if (paramsId !== undefined) {
      return paramsId;
    }

    return id;
  }
}
