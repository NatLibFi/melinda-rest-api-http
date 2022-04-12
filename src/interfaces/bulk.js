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

import httpStatus from 'http-status';
import moment from 'moment';
import sanitize from 'mongo-sanitize';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import {mongoFactory, amqpFactory, QUEUE_ITEM_STATE, OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
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

  // eslint-disable-next-line max-statements
  async function addRecord({correlationId, contentType, data}) {
    // asses rabbit queue for correlationId

    // addBlobSize increases blobSize by 1 and returns the queueItem if there's a queueItem in state WAITING_FOR_RECORDS for correlationId
    const addBlobSizeResult = await mongoOperator.addBlobSize({correlationId});
    logger.silly(`addBlobSizeResult: ${JSON.stringify(addBlobSizeResult)}`);
    const queueItem = addBlobSizeResult.value;

    if (!queueItem) {
      throw new HttpError(httpStatus.NOT_FOUND, `Invalid queueItem ${correlationId} for adding records`);
    }

    // addBlobSize already checked the queueItemState, so this should not happen ever
    if (queueItem.queueItemState !== QUEUE_ITEM_STATE.VALIDATOR.WAITING_FOR_RECORDS) {
      throw new HttpError(httpStatus.BAD_REQUEST, `Invalid state (${queueItem.queueItemState}) for adding records in queueItem ${correlationId}`);
    }

    if (data) {

      const type = contentType;
      const {conversionFormat} = CONTENT_TYPES.find(({contentType, allowBulk}) => contentType === type && allowBulk === true);

      if (!conversionFormat) {
        throw new HttpError(httpStatus.UNSUPPORTED_MEDIA_TYPE, `Invalid content-type`);
      }

      const {operation, cataloger, operationSettings, blobSize} = queueItem;
      const currentSequence = blobSize + 1;
      const headers = {operation, format: conversionFormat, cataloger, operationSettings, recordMetadata: {blobSequence: currentSequence}};

      logger.debug(`Adding record ${currentSequence} for ${correlationId}`);

      const queue = `${QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION}.${correlationId}`;
      await amqpOperator.sendToQueue({queue, correlationId, headers, data});

      return {status: httpStatus.CREATED, payload: `Record has been added to bulk ${correlationId} that has currently ${currentSequence} records`};
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

    const params = generateQuery(incomingParams);

    logger.debug(`Queue items querried with params: ${JSON.stringify(params)}`);

    if (params) {
      return mongoOperator.query(params);
    }

    throw new HttpError(httpStatus.BAD_REQUEST);

    function generateQuery({id, queueItemState, creationTime, modificationTime}) {
      const doc = {};

      if (id) { // eslint-disable-line functional/no-conditional-statement
        doc.correlationId = sanitize(id); // eslint-disable-line functional/immutable-data
      }

      if (queueItemState) { // eslint-disable-line functional/no-conditional-statement
        doc.queueItemState = {$in: queueItemState}; // eslint-disable-line functional/immutable-data
      }

      if (creationTime) {
        if (creationTime.length === 1) { // eslint-disable-line functional/no-conditional-statement
          doc.creationTime = formatTime(creationTime[0]); // eslint-disable-line functional/immutable-data
        } else { // eslint-disable-line functional/no-conditional-statement
          doc.$and = [ // eslint-disable-line functional/immutable-data
            {creationTime: {$gte: formatTime(creationTime[0])}},
            {creationTime: {$lte: formatTime(creationTime[1])}}
          ];
        }
      }

      if (modificationTime) {
        if (modificationTime.length === 1) { // eslint-disable-line functional/no-conditional-statement
          doc.modificationTime = formatTime(modificationTime[0]); // eslint-disable-line functional/immutable-data
        } else { // eslint-disable-line functional/no-conditional-statement
          doc.$and = [ // eslint-disable-line functional/immutable-data
            {modificationTime: {$gte: formatTime(modificationTime[0])}},
            {modificationTime: {$lte: formatTime(modificationTime[1])}}
          ];
        }
      }

      return doc;

      function formatTime(timestamp) {
        if ((/^\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}$/u).test(timestamp)) {
          const time = moment(timestamp).utc();
          return time.toDate();
        }

        // Ditch the timezone
        const time = moment.utc(timestamp);
        return time.toDate();
      }
    }
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

    // NOTE: failOnError currently works on for splitting streamBulk stream to records, not for other validations
    // should these be in config.js ?

    logger.debug(JSON.stringify(queryParams));

    const paramValidate = queryParams.validate ? parseBoolean(queryParams.validate) : undefined;
    const paramUnique = queryParams.unique ? parseBoolean(queryParams.unique) : undefined;
    const paramMerge = queryParams.merge ? parseBoolean(queryParams.merge) : undefined;

    if (paramValidate === false && (paramUnique || paramMerge)) {
      logger.debug(`Query parameter validate=0 is not valid with query parameters unique=1 and/or merge=1`);
      throw new HttpError(httpStatus.BAD_REQUEST, `Query parameter validate=0 is not valid with query parameters unique=1 and/or merge=1`);
    }

    if (paramUnique === false && paramMerge) {
      logger.debug(`Query parameter unique=0 is not valid with query parameter merge=1`);
      throw new HttpError(httpStatus.BAD_REQUEST, `Query parameter unique=0 is not valid with query parameter merge=1`);
    }

    const operationSettings = {
      noStream,
      noop: queryParams.noop ? parseBoolean(queryParams.noop) : false,
      unique: paramValidate ? paramValidate : noStream,
      merge: paramMerge ? paramMerge : false,
      validate: paramValidate ? paramValidate : noStream,
      failOnError: queryParams.failOnError ? parseBoolean(queryParams.failOnError) : false,
      prio: false
    };

    return operationSettings;
  }

  function checkCataloger(id, paramsId) {
    if (paramsId !== undefined) {
      return paramsId;
    }

    return id;
  }
}
