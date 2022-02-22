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
import {Error as HttpError} from '@natlibfi/melinda-commons';
import {mongoFactory, QUEUE_ITEM_STATE} from '@natlibfi/melinda-rest-api-commons';
import httpStatus from 'http-status';
import sanitize from 'mongo-sanitize';

export default async function (mongoUrl) {
  const logger = createLogger();
  const mongoOperator = await mongoFactory(mongoUrl, 'bulk');

  return {create, doQuery, readContent, remove, removeContent, validateQueryParams, checkCataloger};

  async function create(req, {correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams}) {
    await mongoOperator.createBulk({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream: req, prio: false});
    logger.verbose('Stream uploaded!');
    // setState does not do anything with oCatalogerIn or operation
    return mongoOperator.setState({correlationId, oCatalogerIn, operation, state: QUEUE_ITEM_STATE.VALIDATOR.PENDING_QUEUING});
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

      const operation = pOldNew === 'NEW' ? 'CREATE' : 'UPDATE';
      const recordLoadParams = {
        pActiveLibrary: queryParams.pActiveLibrary,
        pOldNew,
        pRejectFile: queryParams.pRejectFile || null,
        pLogFile: queryParams.pLogFile || null,
        pCatalogerIn: queryParams.pCatalogerIn || null
      };
      // Req.params.operation.toUpperCase()
      return {operation, recordLoadParams};
    }

    logger.debug(`bulk/validateQueryParams: mandatory query param missing: pOldNew: ${JSON.stringify(queryParams.pOldNew)}, pActiveLibrary: ${JSON.stringify(queryParams.pActiveLibrary)}`);
    throw new HttpError(httpStatus.BAD_REQUEST, 'Missing one or more mandatory query parameters. (pActiveLibrary, pOldNew)');
  }

  function checkCataloger(id, paramsId) {
    if (paramsId !== undefined) {
      return paramsId;
    }

    return id;
  }
}
