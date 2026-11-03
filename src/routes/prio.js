
//import fs from 'fs';
//import path from 'path';
import {Router} from 'express';
import {inspect} from 'util';
import passport from 'passport';
import {v4 as uuid} from 'uuid';
import {createLogger} from '@natlibfi/melinda-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import createService from '../interfaces/prio.js';
import httpStatus from 'http-status';
import {authorizeKVPOnly, checkAcceptHeader, checkContentType, sanitizeCataloger} from './routeUtils.js';
import {CONTENT_TYPES, DEFAULT_ACCEPT} from '../config.js';
import {checkQueryParams} from './queryUtils.js';

/**
 * Flat view of the request query string (see the QueryParams note in
 * queryUtils.js).
 * @typedef {Object} PrioQueryParams
 * @property {string} [unique]
 * @property {string} [merge]
 * @property {string} [noop]
 * @property {string} [skipLowValidation]
 * @property {string} [skipNoChangeUpdates]
 * @property {string} [matchFailuresAsNew]
 * @property {string} [cataloger]
 * @property {string} [fixType]
 */

/**
 * @param {{sruUrl: string, amqpUrl: string, mongoUri: string, pollWaitTime: number, recordType: string, requireAuthForRead: boolean, requireKVPForWrite: boolean, fixTypes: string[], allowedLibs: string[]}} config
 */
export default async ({sruUrl, amqpUrl, mongoUri, pollWaitTime, recordType, requireAuthForRead, requireKVPForWrite, fixTypes, allowedLibs: _allowedLibs}) => { // eslint-disable-line @typescript-eslint/no-unused-vars -- accepted in the config shape, not used here
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
    return Router()
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
    return Router()
      .use(passport.authenticate('melinda', {session: false}))
      .use(checkQueryParams)
      .get('/:id', checkAcceptHeader, readResource)
      .get('/prio/', authorizeKVPOnly, getPrioLogs)
      .post('/fix/:id', fixResource)
      .post('/', checkContentType, createResource)
      .post('/:id', checkContentType, updateResource);
  }

  //logger.verbose(`Requiring authentication only for writing`);
  return Router()
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

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function readResource(req, res, next) {
    logger.debug(`Request from ${/** @type {any} */(req)?.user?.id || 'N/A'}`);
    logger.silly('routes/Prio readResource');
    try {

      const type = getType();
      const {record} = await Service.read({id: /** @type {string} */(req.params['id']), format: getConversionFormat(type)});

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

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function createResource(req, res, next) {
    logger.debug(`Request from ${/** @type {any} */(req)?.user?.id || 'N/A'}`);
    logger.silly('routes/Prio createResource');
    try {

      const conversionFormat = getConversionFormat(req.headers['content-type']);
      const correlationId = uuid();
      const queryParams = /** @type {PrioQueryParams} */(req.query);
      const user = /** @type {{id: string, authorization: string[]}} */(req.user);

      const operationSettings = {
        unique: queryParams.unique === undefined ? true : parseBoolean(queryParams.unique),
        merge: queryParams.merge === undefined ? false : parseBoolean(queryParams.merge),
        noop: parseBoolean(/** @type {string} */(queryParams.noop)),
        // Prio always validates
        validate: true,
        skipLowValidation: queryParams.skipLowValidation === undefined ? false : parseBoolean(queryParams.skipLowValidation),
        // failOnError is n/a for prio single record jobs
        failOnError: null,
        // Prio forces updates as default, even if the update would not make changes to the database record
        skipNoChangeUpdates: queryParams.skipNoChangeUpdates === undefined ? false : parseBoolean(queryParams.skipNoChangeUpdates),
        matchFailuresAsNew: queryParams.matchFailuresAsNew === undefined ? undefined : parseBoolean(queryParams.matchFailuresAsNew),
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
        cataloger: sanitizeCataloger(user, queryParams.cataloger),
        oCatalogerIn: user.id,
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

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function updateResource(req, res, next) {
    logger.debug(`Request from ${/** @type {any} */(req)?.user?.id || 'N/A'}`);
    logger.silly('routes/Prio updateResource');
    try {
      const conversionFormat = getConversionFormat(req.headers['content-type']);
      const correlationId = uuid();
      const queryParams = /** @type {PrioQueryParams} */(req.query);
      const user = /** @type {{id: string, authorization: string[]}} */(req.user);

      const operationSettings = {
        // unique is n/a for updates
        unique: null,
        merge: queryParams.merge === undefined ? false : parseBoolean(queryParams.merge),
        noop: parseBoolean(/** @type {string} */(queryParams.noop)),
        // Prio always validates
        validate: true,
        skipLowValidation: queryParams.skipLowValidation === undefined ? false : parseBoolean(queryParams.skipLowValidation),
        // failOnError is n/a for prio single record jobs
        failOnError: null,
        // Prio forces updates as default, even if the update would not make changes to the database record
        skipNoChangeUpdates: queryParams.skipNoChangeUpdates === undefined ? false : parseBoolean(queryParams.skipNoChangeUpdates),
        prio: true
      };

      // We have match and merge settings just for bib records in validator
      if (recordType !== 'bib' && (operationSettings.unique || operationSettings.merge)) {
        throw new HttpError(httpStatus.BAD_REQUEST, `Merge can only be used for bib records`);
      }

      const {messages, id} = await Service.update({
        id: /** @type {string} */(req.params['id']),
        format: conversionFormat,
        cataloger: sanitizeCataloger(user, queryParams.cataloger),
        oCatalogerIn: user.id,
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

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function fixResource(req, res, next) {
    logger.debug(`Request from ${/** @type {any} */(req)?.user?.id || 'N/A'}`);
    logger.silly('routes/Prio fixResource');
    try {
      const correlationId = uuid();
      const queryParams = /** @type {PrioQueryParams} */(req.query);
      const user = /** @type {{id: string, authorization: string[]}} */(req.user);

      const {fixType} = queryParams;

      if (fixType === undefined) {
        throw new HttpError(httpStatus.BAD_REQUEST, `Fix requests require fixType.`);
      }

      logger.debug(`FixTypes from config: ${JSON.stringify(fixTypes)}`);

      if (!fixTypes.includes(fixType)) {
        throw new HttpError(httpStatus.BAD_REQUEST, `Invalid fixType ${fixType}.`);
      }

      const operationSettings = {
        fixType,
        // Note: skipLowValidation does not currently work - fixes are not validated
        // skipLowValidation: req.query.skipLowValidation === undefined ? false : parseBoolean(req.query.skipLowValidation),
        noop: parseBoolean(/** @type {string} */(queryParams.noop)),
        // Prio always validates
        validate: true,
        prio: true
      };

      const {messages, id} = await Service.fix({
        id: /** @type {string} */(req.params['id']),
        cataloger: sanitizeCataloger(user, queryParams.cataloger),
        oCatalogerIn: user.id,
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

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function getPrioLogs(req, res, next) {
    logger.debug(`Request from ${/** @type {any} */(req)?.user?.id || 'N/A'}`);
    logger.silly('routes/Prio doQuery');
    try {
      const response = await Service.doQuery(req.query);
      res.json(response);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  /** @param {string | undefined} type */
  function getConversionFormat(type) {
    const {conversionFormat} = /** @type {any} */(CONTENT_TYPES.find(({contentType}) => contentType === type));
    return conversionFormat;
  }


};
