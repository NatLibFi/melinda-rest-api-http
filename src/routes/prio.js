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
import HttpStatus from 'http-status';
import {v4 as uuid} from 'uuid';
import {Utils, Error as HttpError} from '@natlibfi/melinda-commons';
import {conversionFormats} from '@natlibfi/melinda-rest-api-commons';
import createService from '../interfaces/prio';

export default async ({sruBibUrl, amqpUrl, pollWaitTime}) => {
  const {createLogger, parseBoolean} = Utils;
  const logger = createLogger();
  const CONTENT_TYPES = {
    'application/json': conversionFormats.JSON,
    'application/marc': conversionFormats.ISO2709,
    'application/xml': conversionFormats.MARCXML
  };

  const Service = await createService({
    sruBibUrl, amqpUrl, pollWaitTime
  });

  return new Router()
    .use(passport.authenticate('melinda', {session: false}))
    .use(checkContentType)
    .post('/', createResource)
    .get('/:id', readResource)
    .post('/:id', updateResource);

  async function readResource(req, res, next) {
    try {
      const type = req.headers['content-type'];
      const format = CONTENT_TYPES[type];
      const record = await Service.read({id: req.params.id, format});
      res.type(type).status(HttpStatus.OK)
        .send(record);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  async function createResource(req, res, next) {
    try {
      const type = req.headers['content-type'];
      const format = CONTENT_TYPES[type];
      const correlationId = uuid();

      const unique = req.query.unique === undefined ? true : parseBoolean(req.query.unique);
      const noop = parseBoolean(req.query.noop);
      const messages = await Service.create({
        format,
        unique,
        noop,
        data: req.body,
        cataloger: req.user,
        correlationId
      });

      if (noop) {
        res.status(HttpStatus.CREATED).set('Record-ID', messages.id);
        return;
      }

      res.type('application/json').send(messages);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  async function updateResource(req, res, next) {
    try {
      const type = req.headers['content-type'];
      const format = CONTENT_TYPES[type];
      const correlationId = uuid();

      // Id must contain 9 digits nothing less, nothing more.
      const noop = parseBoolean(req.query.noop);
      const messages = await Service.update({
        id: req.params.id,
        data: req.body,
        format,
        cataloger: req.user,
        noop,
        correlationId
      });
      res.status(HttpStatus.OK).set('Record-ID', messages.id);
      res.type('application/json').json(messages);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  function checkContentType(req, res, next) {
    if (req.headers['content-type'] === undefined || !CONTENT_TYPES[req.headers['content-type']]) { // eslint-disable-line functional/no-conditional-statement
      logger.log('debug', 'Invalid content type');
      throw new HttpError(HttpStatus.NOT_ACCEPTABLE, 'Invalid content-type');
    }

    return next();
  }
};
