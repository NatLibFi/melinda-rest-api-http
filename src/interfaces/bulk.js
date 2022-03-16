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
import {mongoFactory, amqpFactory, QUEUE_ITEM_STATE, OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import httpStatus from 'http-status';
import sanitize from 'mongo-sanitize';
import {CONTENT_TYPES} from '../config';

export default async function ({mongoUri, amqpUrl}) {
  const logger = createLogger();
  const mongoOperator = await mongoFactory(mongoUri, 'bulk');
  const amqpOperator = await amqpFactory(amqpUrl);

  return {create, addRecord, getState, updateState, doQuery, readContent, remove, removeContent, validateQueryParams, checkCataloger};

  async function create({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, operationSettings, stream}) {
    const result = await mongoOperator.createBulk({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream, operationSettings, prio: false});
    if (!stream) {
      logger.verbose('NoStream bulk ready!');
      return result;
    }

    logger.verbose('Stream uploaded!');
    // setState does not do anything with oCatalogerIn or operation
    return mongoOperator.setState({correlationId, oCatalogerIn, operation, state: QUEUE_ITEM_STATE.VALIDATOR.PENDING_QUEUING});
  }

  async function addRecord({correlationId, contentType, data}) {
    // asses rabbit queue for correlationId

    // check that there is a queue item, and queueItemState = VALIDATOR.WAITING_FOR_RECORDS
    // get headers
    const queueItem = await mongoOperator.queryById({correlationId});

    if (!queueItem) {
      throw new HttpError(httpStatus.NOT_FOUND, `Invalid queueItem ${correlationId}`);
    }

    if (queueItem.queueItemState !== QUEUE_ITEM_STATE.VALIDATOR.WAITING_FOR_RECORDS) {
      throw new HttpError(httpStatus.BAD_REQUEST, `Invalid state (${queueItem.queueItemState} for adding records in queueItem ${correlationId}`);
    }

    if (data) {

      // contentType from the request - we can have different contentTypes in one job?
      const format = CONTENT_TYPES.prio[contentType];
      const {operation, cataloger, operationSettings} = queueItem;
      const headers = {operation, format, cataloger, operationSettings};

      logger.debug('Got record');
      logger.debug(`Adding record for ${correlationId}`);
      await amqpOperator.sendToQueue({queue: `${QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION}.${correlationId}`, correlationId, headers, data});

      return {status: httpStatus.CREATED, payload: `Record has been added to bulk ${correlationId}`};
    }

    throw new HttpError(httpStatus.BAD_REQUEST, 'No record.');
  }

  async function getState(params) {
    logger.debug(`Getting current state of ${params.correlationId}`);
    const [{correlationId, queueItemState, modificationTime}] = await mongoOperator.query(params);

    if (queueItemState) {
      return {status: httpStatus.OK, payload: {correlationId, queueItemState, modificationTime}};
    }

    throw new HttpError(httpStatus.NOT_FOUND, `Item not found for id: ${params.correlationId}`);
  }

  async function updateState({correlationId, state}) {
    logger.debug(`Updating current state of ${correlationId} to ${state}`);
    const {value} = await mongoOperator.setState({correlationId, state});
    if (value) {
      const {queueItemState, modificationTime} = value;
      return {status: httpStatus.OK, payload: {correlationId, queueItemState, modificationTime}};
    }

    throw new HttpError(httpStatus.NOT_FOUND, `Item not found for id: ${correlationId}`);
  }

  function readContent(correlationId) {
    logger.debug(`Reading content for ${correlationId}`);
    if (correlationId) {
      return mongoOperator.readContent(correlationId);
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  function remove({oCatalogerIn, correlationId}) {

    // eslint-disable-next-line functional/no-conditional-statement
    if (correlationId) {
      const removeResult = mongoOperator.remove({oCatalogerIn, correlationId});
      return removeResult;
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  function removeContent({oCatalogerIn, correlationId}) {
    if (correlationId) {
      const removeContentResult = mongoOperator.removeContent({oCatalogerIn, correlationId});
      return removeContentResult;
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

  function validateAndGetOperationSettings(queryParams, noStream) {

    // validate: false + unique/merge/failOnError: true are not sane combinations
    // unique: false + merge: true is not a sane combination

    // should these be in config.js ?

    logger.debug(JSON.stringify(queryParams));

    const operationSettingsForBatchBulk = {
      noStream,
      noop: queryParams.noop ? parseBoolean(queryParams.noop) : false,
      unique: queryParams.unique ? parseBoolean(queryParams.unique) : true,
      merge: queryParams.merge ? parseBoolean(queryParams.merge) : false,
      validate: queryParams.validate ? parseBoolean(queryParams.validate) : true,
      failOnError: queryParams.failOnError ? parseBoolean(queryParams.failOnError) : false,
      prio: false
    };

    const operationSettingsForStreamBulk = {
      noStream,
      noop: queryParams.noop ? parseBoolean(queryParams.noop) : false,
      unique: queryParams.unique ? parseBoolean(queryParams.unique) : false,
      merge: queryParams.merge ? parseBoolean(queryParams.merge) : false,
      validate: queryParams.validate ? parseBoolean(queryParams.validate) : false,
      failOnError: queryParams.failOnError ? parseBoolean(queryParams.failOnError) : false,
      prio: false
    };

    return noStream ? operationSettingsForBatchBulk : operationSettingsForStreamBulk;
  }

  function checkCataloger(id, paramsId) {
    if (paramsId !== undefined) {
      return paramsId;
    }

    return id;
  }
}
