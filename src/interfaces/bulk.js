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
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import {mongoFactory, amqpFactory, QUEUE_ITEM_STATE, OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import {CONTENT_TYPES} from '../config';
import {generateQuery, generateShowParams} from './utils';
// import {inspect} from 'util';

export default async function ({mongoUri, amqpUrl}) {
  const logger = createLogger();
  const mongoOperator = await mongoFactory(mongoUri, 'bulk');
  const amqpOperator = await amqpFactory(amqpUrl);

  return {create, addRecord, getState, updateState, doQuery, readContent, remove, removeContent, validateQueryParams, checkCataloger};

  async function create({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, operationSettings, stream}) {
    const result = await mongoOperator.createBulk({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream, operationSettings, prio: false});
    if (!stream) {
      logger.verbose(`NoStream bulk ready to receive records ${correlationId}!`);
      return result;
    }

    logger.verbose(`Stream uploaded for ${correlationId}!`);
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
      const headers = {correlationId, operation, format: conversionFormat, cataloger, operationSettings, recordMetadata: {blobSequence: currentSequence}};

      logger.debug(`Adding record ${currentSequence} for ${correlationId}`);

      const queue = `${QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION}.${correlationId}`;
      await amqpOperator.sendToQueue({queue, correlationId, headers, data});

      return {status: httpStatus.CREATED, payload: `Record has been added to bulk ${correlationId} that has currently ${currentSequence} records`};
    }

    throw new HttpError(httpStatus.BAD_REQUEST, 'No record.');
  }

  async function getState(params) {
    logger.debug(`Getting current state of ${params.correlationId}`);

    const result = await mongoOperator.query(params);
    logger.silly(`Result from query: ${JSON.stringify(result)}`);

    if (!result || result.length < 1) {
      throw new HttpError(httpStatus.NOT_FOUND, `Item not found for id: ${params.correlationId}`);
    }

    const [{correlationId, queueItemState, modificationTime}] = result;

    if (queueItemState && correlationId && modificationTime) {
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

  async function doQuery(incomingParams) {
    const params = generateQuery(incomingParams);
    const showParams = generateShowParams(incomingParams);
    const {recordsAsReport, noRecords, noIds} = incomingParams;
    const report = recordsAsReport === undefined ? false : parseBoolean(recordsAsReport);
    const removeRecords = noRecords === undefined ? false : parseBoolean(noRecords);
    const removeIds = noIds === undefined ? false : parseBoolean(noIds);

    logger.debug(`Queue items querried with params: ${JSON.stringify(params)}`);

    if (params) {
      const result = await mongoOperator.query(params, showParams);
      if (report) {
        logger.debug(`Reducing recordItems to recordReport`);
        return result.map(queueItem => createRecordReport({queueItem, report, removeRecords, removeIds}));
      }
      return result;
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  // eslint-disable-next-line max-statements
  function createRecordReport({queueItem, report = true, removeRecords = true, removeIds = true}) {

    if (!report && !removeRecords && !removeIds) {
      logger.silly(`Returning queueItem as it is`);
      return queueItem;
    }

    const {records, handledIds, rejectedIds, ...rest} = queueItem;
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

      if (!removeRecords) {
        logger.silly(`Removing ids.`);
        if (removeIds) {
          return {...rest, records};
        }
        logger.silly(`Returning queueItem as it is`);
        return queueItem;
      }
    }

    if (report) {
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

      if (!removeRecords) {
        if (removeIds) {
          logger.silly(`Returning report and records, and removing ids`);
          return {...rest, recordReport, records};
        }
        logger.silly(`Returning report and queueItem as it is`);
        return {queueItem, recordReport};
      }
    }
  }

  function reportRecordStatuses(records) {
    const recordStatuses = records.reduce((allStatuses, record) => {
      logger.silly(`Handling record: ${JSON.stringify(record)}`);
      logger.silly(`Current allStatuses: ${JSON.stringify(allStatuses)}`);

      if (record.status in allStatuses) {
        logger.silly(`We have an existing status: ${record.status}`);
        return {
          ...allStatuses,
          [record.status]: allStatuses[record.status] + 1
        };
      }

      logger.silly(`We have a new status: ${record.status}`);
      return {
        ...allStatuses,
        [record.status]: 1
      };
    }, {});

    logger.debug(JSON.stringify(recordStatuses));
    return recordStatuses;
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

    // noStream == batchBulk:   validate & unique are as default true
    // !noStream == streamBulk: validate & unique are as default false

    const operationSettings = {
      noStream,
      noop: queryParams.noop === undefined ? false : parseBoolean(queryParams.noop),
      unique: paramUnique === undefined ? noStream : paramUnique,
      merge: paramMerge === undefined ? false : paramMerge,
      validate: paramValidate === undefined ? noStream : paramValidate,
      failOnError: queryParams.failOnError === undefined ? false : parseBoolean(queryParams.failOnError),
      // bulk skips changes that won't change the database record as default
      skipNoChangeUpdates: queryParams.skipNoChangeUpdates === undefined ? true : parseBoolean(queryParams.skipNoChangeUpdates),
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
