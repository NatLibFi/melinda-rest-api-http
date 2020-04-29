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
import HttpStatus from 'http-status';
import passport from 'passport';
import {v4 as uuid} from 'uuid';
import {Error as HttpError, Utils} from '@natlibfi/melinda-commons';
import {OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import createService from '../interfaces/bulk';

export default async function (mongoUrl) {
  const {createLogger} = Utils;
  const logger = createLogger();

  const CONTENT_TYPES = [
    'application/xml',
    'application/marc',
    'application/json',
    'application/alephseq'
  ];
  const OPERATION_TYPES = [
    OPERATIONS.CREATE,
    OPERATIONS.UPDATE
  ];
  const Service = await createService(mongoUrl);

  return new Router()
    .use(passport.authenticate('melinda', {session: false}))
    .use(checkContentType)
    .post('/:operation', create)
    .get('/', doQuery)
    .get('/:id', readContent)
    .delete('/', remove)
    .delete('/:id', removeContent);

  async function create(req, res, next) {
    try {
      logger.log('verbose', 'routes/Bulk create');
      const params = {
        correlationId: uuid(),
        cataloger: req.user.id,
        operation: req.params.operation.toUpperCase(),
        contentType: req.headers['content-type'],
        recordLoadParams: req.query || null
      };

      logger.log('verbose', 'Params done');
      if (params.operation && OPERATION_TYPES.includes(params.operation)) {
        const response = await Service.create(req, params);
        res.json(response);
        return;
      }

      logger.log('verbose', 'Invalid operation');
      throw new HttpError(HttpStatus.BAD_REQUEST, 'Invalid operation');
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
      logger.log('verbose', 'Invalid content type');
      throw new HttpError(HttpStatus.NOT_ACCEPTABLE, 'Invalid content-type');
    }

    return next();
  }

  async function doQuery(req, res) {
    logger.log('verbose', 'routes/Bulk doQuery');
    const response = await Service.doQuery({cataloger: req.user.id, query: req.query});
    res.json(response);
  }

  /* Functions after this are here only to test purposes */
  async function readContent(req, res) {
    logger.log('verbose', 'routes/Bulk readContent');
    const {contentType, readStream} = await Service.readContent({cataloger: req.user.id, correlationId: req.params.id});
    res.set('content-type', contentType);
    readStream.pipe(res);
  }

  async function remove(req, res, next) {
    logger.log('verbose', 'routes/Bulk remove');
    try {
      const response = await Service.remove({cataloger: req.user.id, correlationId: req.query.id});
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
    logger.log('verbose', 'routes/Bulk removeContent');
    try {
      await Service.removeContent({cataloger: req.user.id, correlationId: req.params.id});
      res.sendStatus(204);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }

      return next(error);
    }
  }
}
