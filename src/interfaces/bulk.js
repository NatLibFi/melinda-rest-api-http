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

import {Error as HttpError, Utils} from '@natlibfi/melinda-commons';
import {mongoFactory, QUEUE_ITEM_STATE} from '@natlibfi/melinda-rest-api-commons';
import httpStatus from 'http-status';

const {createLogger} = Utils;

export default async function (mongoUrl) {
  const logger = createLogger();
  const mongoOperator = await mongoFactory(mongoUrl);

  return {create, doQuery, readContent, remove, removeContent, validateQueryParams, checkCataloger};

  async function create(req, {correlationId, cataloger, operation, contentType, recordLoadParams}) {
    await mongoOperator.createBulk({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream: req});
    logger.log('verbose', 'Stream uploaded!');
    return mongoOperator.setState({correlationId, cataloger, operation, state: QUEUE_ITEM_STATE.PENDING_QUEUING});
  }

  function readContent({cataloger, correlationId}) {
    if (correlationId) {
      return mongoOperator.readContent({cataloger, correlationId});
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  function remove({cataloger, correlationId}) {
    if (correlationId) {
      return mongoOperator.remove({cataloger, correlationId});
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  function removeContent({cataloger, correlationId}) {
    if (correlationId) {
      return mongoOperator.removeContent({cataloger, correlationId});
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  async function doQuery({cataloger, query}) {
    // Query filters cataloger, correlationId, operation, creationTime, modificationTime
    const params = await generateQuery();
    logger.log('debug', `Queue items querried`);
    logger.log('silly', JSON.stringify(params));

    if (params) {
      return mongoOperator.query(params);
    }

    throw new HttpError(httpStatus.BAD_REQUEST);

    function generateQuery() {
      const doc = {
        oCatalogerIn: cataloger ? cataloger : null,
        correlationId: query.id ? query.id : {$ne: null},
        operation: query.operation ? query.operation : {$ne: null}
      };

      if (doc.cataloger === null) {
        return false;
      }

      return doc;
    }
  }

  function validateQueryParams(queryParams) {
    if (queryParams.pOldNew && queryParams.pActiveLibrary) {
      const {pOldNew} = queryParams;
      const operation = pOldNew === 'NEW' ? 'CREATE' : 'UPDATE';
      const recordLoadParams = {
        pActiveLibrary: queryParams.pActiveLibrary,
        pOldNew,
        pRejectFile: queryParams.pRejectFile || null,
        pLogFile: queryParams.pRejectFile || null,
        pCatalogerIn: queryParams.pCatalogerIn || null,
      };
      // Req.params.operation.toUpperCase()
      return {operation, recordLoadParams};
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  function checkCataloger(id, paramsId) {
    if (paramsId !== undefined) {
      return paramsId;
    }

    return id;
  }
}
