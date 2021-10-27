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

import {Router} from 'express';
import httpStatus from 'http-status';
import passport from 'passport';
import {v4 as uuid} from 'uuid';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import {OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import createService from '../interfaces/bulk';
import {authorizeKVPOnly} from './routeUtils';

export default async function (mongoUrl) {
  const logger = createLogger();

  const CONTENT_TYPES = ['application/xml', 'application/marc', 'application/json', 'application/alephseq'];
  const OPERATION_TYPES = [OPERATIONS.CREATE, OPERATIONS.UPDATE];
  const Service = await createService(mongoUrl);

  return new Router()
    .use(passport.authenticate('melinda', {session: false}))
    .use(authorizeKVPOnly)
    .get('/:id', readContent)
    .get('/', doQuery)
    .delete('/:id', removeContent)
    .delete('/', remove)
    .use(checkContentType)
    .post('/', create);

  async function create(req, res, next) {
    try {
      logger.silly('routes/Bulk create');
      const {operation, recordLoadParams} = Service.validateQueryParams(req.query, req.user.id);
      const params = {
        correlationId: uuid(),
        cataloger: Service.checkCataloger(req.user.id, req.query.pCatalogerIn),
        oCatalogerIn: req.user.id,
        operation,
        contentType: req.headers['content-type'],
        recordLoadParams
      };

      logger.silly('Params done');
      if (params.operation && OPERATION_TYPES.includes(params.operation)) {
        const response = await Service.create(req, params);
        res.json(response);
        return;
      }

      logger.debug('Invalid operation');
      throw new HttpError(httpStatus.BAD_REQUEST, 'Invalid operation');
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  function checkContentType(req, res, next) {
    if (req.headers['content-type'] === undefined || !CONTENT_TYPES.includes(req.headers['content-type'])) { // eslint-disable-line functional/no-conditional-statement
      logger.verbose('Invalid content type');
      throw new HttpError(httpStatus.UNSUPPORTED_MEDIA_TYPE, 'Invalid content-type');
    }

    return next();
  }

  async function doQuery(req, res, next) {
    try {
      logger.silly('routes/Bulk doQuery');
      const response = await Service.doQuery({query: req.query});
      res.json(response);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  /* Functions after this are here only to test purposes */
  async function readContent(req, res, next) {
    try {
      logger.silly('routes/Bulk readContent');
      const {contentType, readStream} = await Service.readContent(req.params.id);
      res.set('content-type', contentType);
      readStream.pipe(res);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  async function remove(req, res, next) {
    logger.silly('routes/Bulk remove');
    try {
      const response = await Service.remove({oCatalogerIn: req.user.id, correlationId: req.query.id});
      res.json({request: req.query, result: response});
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }

      return next(error);
    }
  }

  async function removeContent(req, res, next) {
    logger.silly('routes/Bulk removeContent');
    try {
      await Service.removeContent({oCatalogerIn: req.user.id, correlationId: req.params.id});
      res.sendStatus(204);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }

      return next(error);
    }
  }
}
