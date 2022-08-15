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
import {inspect} from 'util';
import passport from 'passport';
import {v4 as uuid} from 'uuid';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import createService from '../interfaces/prio';
import httpStatus from 'http-status';
import {authorizeKVPOnly, checkAcceptHeader, checkContentType, sanitizeCataloger} from './routeUtils';
import {CONTENT_TYPES} from '../config';
import {checkQueryParams} from './queryUtils';

export default async ({sruUrl, amqpUrl, mongoUri, pollWaitTime}) => {
  const logger = createLogger();
  const Service = await createService({
    sruUrl, amqpUrl, mongoUri, pollWaitTime
  });

  return new Router()
    .use(checkQueryParams)
    .get('/:id', checkAcceptHeader, readResource)
    .use(passport.authenticate('melinda', {session: false}))
    .get('/prio/', authorizeKVPOnly, getPrioLogs)
    .post('/', checkContentType, createResource)
    .post('/:id', checkContentType, updateResource);

  async function readResource(req, res, next) {
    logger.silly('routes/Prio readResource');
    try {
      const type = req.headers.accept;
      const {conversionFormat} = CONTENT_TYPES.find(({contentType}) => contentType === type);
      const {record} = await Service.read({id: req.params.id, format: conversionFormat});

      return res.type(type).status(httpStatus.OK)
        .send(record);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  // eslint-disable-next-line max-statements
  async function createResource(req, res, next) {
    logger.silly('routes/Prio createResource');
    try {
      const type = req.headers['content-type'];
      const {conversionFormat} = CONTENT_TYPES.find(({contentType}) => contentType === type);
      const correlationId = uuid();

      const operationSettings = {
        unique: req.query.unique === undefined ? true : parseBoolean(req.query.unique),
        merge: req.query.merge === undefined ? false : parseBoolean(req.query.merge),
        noop: parseBoolean(req.query.noop),
        // Prio always validates
        validate: true,
        // failOnError is n/a for prio single record jobs
        failOnError: null,
        prio: true
      };

      if (operationSettings.merge && !operationSettings.unique) {
        throw new HttpError(httpStatus.BAD_REQUEST, `Merge cannot be used with unique set as **false**`);
      }

      const {messages, id, status} = await Service.create({
        format: conversionFormat,
        cataloger: sanitizeCataloger(req.user, req.query.cataloger),
        oCatalogerIn: req.user.id,
        correlationId,
        operationSettings,
        data: req.body
      });

      // create returns: {messages:<messages> id:<id>, status: CREATED/UPDATED}
      // logger.silly(`messages: ${inspect(messages, {colors: true, maxArrayLength: 3, depth: 1})}`);
      // logger.silly(`id: ${inspect(id, {colors: true, maxArrayLength: 3, depth: 1})}`);

      // CREATED + id for non-noop creates
      if (status === 'CREATED' && !operationSettings.noop) {
        res.status(httpStatus.CREATED).set('Record-ID', id)
          .json(messages);
        return;
      }

      // OK + id for merged cases (noop & non-noop)
      if (status === 'UPDATED') {
        res.status(httpStatus.OK).set('Record-ID', id)
          .json(messages);
        return;
      }

      // just OK for noop creates
      res.status(httpStatus.OK).json(messages);
    } catch (error) {
      if (error instanceof HttpError) {
        logger.debug(`${JSON.stringify(error)}`);
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }


  }

  async function updateResource(req, res, next) {
    logger.silly('routes/Prio updateResource');
    try {
      const type = req.headers['content-type'];
      const {conversionFormat} = CONTENT_TYPES.find(({contentType}) => contentType === type);
      const correlationId = uuid();

      const operationSettings = {
        // unique is n/a for updates
        unique: null,
        merge: req.query.merge === undefined ? false : parseBoolean(req.query.merge),
        noop: parseBoolean(req.query.noop),
        // Prio always validates
        validate: true,
        // failOnError is n/a for prio single record jobs
        failOnError: null,
        prio: true
      };

      const {messages, id} = await Service.update({
        id: req.params.id,
        format: conversionFormat,
        cataloger: sanitizeCataloger(req.user, req.query.cataloger),
        oCatalogerIn: req.user.id,
        operationSettings,
        correlationId,
        data: req.body
      });

      logger.silly(`messages: ${inspect(messages, {colors: true, maxArrayLength: 3, depth: 1})}`);

      // Note: noops return OK even if they fail marc-record-validate validations
      return res.status(httpStatus.OK).set('Record-ID', id)
        .json(messages);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  async function getPrioLogs(req, res) {
    logger.silly('routes/Bulk doQuery');
    const response = await Service.doQuery(req.query);
    res.json(response);
  }
};
