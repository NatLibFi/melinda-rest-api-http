
//import fs from 'fs';
//import path from 'path';
import {Router} from 'express';
import {inspect} from 'util';
import passport from 'passport';
import {v4 as uuid} from 'uuid';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import createService from '../interfaces/prio';
import httpStatus from 'http-status';
import {authorizeKVPOnly, checkAcceptHeader, checkContentType, sanitizeCataloger} from './routeUtils';
import {CONTENT_TYPES, DEFAULT_ACCEPT} from '../config';
import {checkQueryParams} from './queryUtils';

// eslint-disable-next-line no-unused-vars
export default async ({sruUrl, amqpUrl, mongoUri, pollWaitTime, recordType, requireAuthForRead, requireKVPForWrite, fixTypes}) => {
  const logger = createLogger();
  //const apiDoc = fs.readFileSync(path.join(__dirname, '..', 'api.yaml'), 'utf8');
  const Service = await createService({
    sruUrl, amqpUrl, mongoUri, pollWaitTime
  });

  //logger.debug(`Read: ${requireAuthForRead} write: ${requireKVPForWrite}`);
  // Require KVP authentication for creates/updates if requireKVPForWrite is true
  // Note: this also requires general authentication for read

  if (requireKVPForWrite) {
    logger.verbose(`Requiring authentication for reading and KVP authentication for writing`);
    return new Router()
      .use(passport.authenticate('melinda', {session: false}))
      .use(checkQueryParams)
      .get('/:id', checkAcceptHeader, readResource)
      .get('/prio/', authorizeKVPOnly, getPrioLogs)
      .post('/fix/:id', authorizeKVPOnly, fixResource)
      .post('/', authorizeKVPOnly, checkContentType, createResource)
      .post('/:id', authorizeKVPOnly, checkContentType, updateResource);
  }

  // Require authentication before reading if requireAuthForRead is true
  if (requireAuthForRead) {
    logger.verbose(`Requiring authentication for reading and writing`);
    return new Router()
      .use(passport.authenticate('melinda', {session: false}))
      .use(checkQueryParams)
      .get('/:id', checkAcceptHeader, readResource)
      .get('/prio/', authorizeKVPOnly, getPrioLogs)
      .post('/fix/:id', fixResource)
      .post('/', checkContentType, createResource)
      .post('/:id', checkContentType, updateResource);
  }

  //logger.verbose(`Requiring authentication only for writing`);
  return new Router()
    .use(checkQueryParams)
    .get('/:id', checkAcceptHeader, readResource)
    //.get('/apidoc/', serveApiDoc)
    .use(passport.authenticate('melinda', {session: false}))
    .get('/prio/', authorizeKVPOnly, getPrioLogs)
    .post('/fix/:id', fixResource)
    .post('/', checkContentType, createResource)
    .post('/:id', checkContentType, updateResource);

  /*
    function serveApiDoc(req, res) {
    res.set('Content-Type', 'application/yaml');
    res.send(apiDoc);
  }
  */

  async function readResource(req, res, next) {
    logger.debug(`Request from ${req?.user?.id || 'N/A'}`);
    logger.silly('routes/Prio readResource');
    try {

      const type = getType();
      const {record} = await Service.read({id: req.params.id, format: getConversionFormat(type)});

      return res.type(type).status(httpStatus.OK)
        .send(record);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }

    function getType() {
      // Note - this doesn't work if accept-header has several accepted types (ie. in browsers)
      if (req.headers.accept === '*/*') {
        logger.debug(`Accept header ${req.headers.accept}, using DEFAULT_ACCEPT: ${DEFAULT_ACCEPT}`);
        return DEFAULT_ACCEPT;
      }
      return req.headers.accept;
    }

  }

  // eslint-disable-next-line max-statements
  async function createResource(req, res, next) {
    logger.debug(`Request from ${req?.user?.id || 'N/A'}`);
    logger.silly('routes/Prio createResource');
    try {

      const conversionFormat = getConversionFormat(req.headers['content-type']);
      const correlationId = uuid();

      const operationSettings = {
        unique: req.query.unique === undefined ? true : parseBoolean(req.query.unique),
        merge: req.query.merge === undefined ? false : parseBoolean(req.query.merge),
        noop: parseBoolean(req.query.noop),
        // Prio always validates
        validate: true,
        // failOnError is n/a for prio single record jobs
        failOnError: null,
        // Prio forces updates as default, even if the update would not make changes to the database record
        skipNoChangeUpdates: req.query.skipNoChangeUpdates === undefined ? false : parseBoolean(req.query.skipNoChangeUpdates),
        prio: true
      };

      // We have match and merge settings just for bib records in validator
      if (recordType !== 'bib' && (operationSettings.unique || operationSettings.merge)) {
        throw new HttpError(httpStatus.BAD_REQUEST, `Unique and merge can only be used for bib records, use unique=0`);
      }

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
      if (status === 'UPDATED' || status === 'SKIPPED') {
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
    logger.debug(`Request from ${req?.user?.id || 'N/A'}`);
    logger.silly('routes/Prio updateResource');
    try {
      const conversionFormat = getConversionFormat(req.headers['content-type']);
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
        // Prio forces updates as default, even if the update would not make changes to the database record
        skipNoChangeUpdates: req.query.skipNoChangeUpdates === undefined ? false : parseBoolean(req.query.skipNoChangeUpdates),
        prio: true
      };

      // We have match and merge settings just for bib records in validator
      if (recordType !== 'bib' && (operationSettings.unique || operationSettings.merge)) {
        throw new HttpError(httpStatus.BAD_REQUEST, `Merge can only be used for bib records`);
      }

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

  async function fixResource(req, res, next) {
    logger.debug(`Request from ${req?.user?.id || 'N/A'}`);
    logger.silly('routes/Prio fixResource');
    try {
      const correlationId = uuid();

      const {fixType} = req.query;

      if (fixType === undefined) {
        throw new HttpError(httpStatus.BAD_REQUEST, `Fix requests require fixType.`);
      }

      logger.debug(`FixTypes from config: ${JSON.stringify(fixTypes)}`);

      if (!fixTypes.includes(fixType)) {
        throw new HttpError(httpStatus.BAD_REQUEST, `Invalid fixType ${fixType}.`);
      }

      const operationSettings = {
        fixType,
        noop: parseBoolean(req.query.noop),
        // Prio always validates
        validate: true,
        prio: true
      };

      const {messages, id} = await Service.fix({
        id: req.params.id,
        cataloger: sanitizeCataloger(req.user, req.query.cataloger),
        oCatalogerIn: req.user.id,
        operationSettings,
        correlationId
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
    logger.debug(`Request from ${req?.user?.id || 'N/A'}`);
    logger.silly('routes/Bulk doQuery');
    const response = await Service.doQuery(req.query);
    res.json(response);
  }

  function getConversionFormat(type) {
    const {conversionFormat} = CONTENT_TYPES.find(({contentType}) => contentType === type);
    return conversionFormat;
  }


};
