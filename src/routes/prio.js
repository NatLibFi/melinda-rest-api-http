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
import passport from 'passport';
import {v4 as uuid} from 'uuid';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import {conversionFormats} from '@natlibfi/melinda-rest-api-commons';
import createService from '../interfaces/prio';
import httpStatus from 'http-status';

export default async ({sruUrl, amqpUrl, mongoUri, pollWaitTime}) => {
  const logger = createLogger();
  const CONTENT_TYPES = {
    'application/json': conversionFormats.JSON,
    'application/marc': conversionFormats.ISO2709,
    'application/xml': conversionFormats.MARCXML
  };

  const Service = await createService({
    sruUrl, amqpUrl, mongoUri, pollWaitTime
  });

  return new Router()
    .use(passport.authenticate('melinda', {session: false}))
    .get('/:id', readResource)
    .use(checkContentType)
    .post('/', createResource)
    .post('/:id', updateResource);

  async function readResource(req, res, next) {
    logger.log('verbose', 'routes/Prio readResource');
    try {
      const type = req.headers.accept;
      const format = CONTENT_TYPES[type];
      const {record} = await Service.read({id: req.params.id, format});

      return res.type(type).status(httpStatus.OK)
        .send(record);
    } catch (error) {
      if (error instanceof HttpError) { // eslint-disable-line functional/no-conditional-statement
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  async function createResource(req, res, next) {
    logger.log('verbose', 'routes/Prio createResource');
    try {
      const type = req.headers['content-type'];
      const format = CONTENT_TYPES[type];
      const correlationId = uuid();
      const unique = req.query.unique === undefined ? true : parseBoolean(req.query.unique);
      const noop = parseBoolean(req.query.noop);
      const {messages, id} = await Service.create({
        format,
        unique,
        noop,
        data: req.body,
        cataloger: sanitizeCataloger(req.user, req.query.cataloger),
        oCatalogerIn: req.user.id,
        correlationId
      });

      if (!noop) {
        res.status(httpStatus.CREATED).set('Record-ID', id)
          .json(messages);
        return;
      }

      res.status(httpStatus.OK).json(messages);
    } catch (error) {
      if (error instanceof HttpError) { // eslint-disable-line functional/no-conditional-statement
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  async function updateResource(req, res, next) {
    logger.log('verbose', 'routes/Prio updateResource');
    try {
      const type = req.headers['content-type'];
      const format = CONTENT_TYPES[type];
      const correlationId = uuid();

      const noop = parseBoolean(req.query.noop);
      const messages = await Service.update({
        id: req.params.id,
        data: req.body,
        format,
        cataloger: sanitizeCataloger(req.user, req.query.cataloger),
        oCatalogerIn: req.user.id,
        noop,
        correlationId
      });

      return res.status(httpStatus.OK).json(messages);
    } catch (error) {
      if (error instanceof HttpError) { // eslint-disable-line functional/no-conditional-statement
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  function checkContentType(req, res, next) {
    if (req.headers['content-type'] === undefined || !CONTENT_TYPES[req.headers['content-type']]) {
      logger.log('verbose', 'Invalid content type');
      return res.status(httpStatus.UNSUPPORTED_MEDIA_TYPE).send('Invalid content-type');
    }

    return next();
  }

  function sanitizeCataloger(passportCataloger, queryCataloger) {
    const {id, authorization} = passportCataloger;

    if (authorization.includes('KVP') && queryCataloger) {
      return {id: queryCataloger, authorization};
    }

    if (!authorization.includes('KVP') && queryCataloger !== undefined) { // eslint-disable-line functional/no-conditional-statement
      throw new HttpError(httpStatus.FORBIDDEN, 'Account has no permission to do this request');
    }

    return {id, authorization};
  }
};
