//import fs from 'fs';
//import path from 'path';
import {Router} from 'express';
import {inspect} from 'util';
import passport from 'passport';
import {v4 as uuid} from 'uuid';
import {createLogger} from '@natlibfi/melinda-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import createService from '../interfaces/prio.ts';
import httpStatus from 'http-status';
import {authorizeKVPOnly, checkAcceptHeader, checkContentType, sanitizeCataloger} from './routeUtils.ts';
import {CONTENT_TYPES, DEFAULT_ACCEPT} from '../config.ts';
import {checkQueryParams} from './queryUtils.ts';
import type {NextFunction, Request, Response} from 'express';
import type {Cataloger} from './routeUtils.ts';

/**
 * Flat view of the request query string (see the QueryParams note in
 * queryUtils.ts).
 */
interface PrioQueryParams {
  unique?: string;
  merge?: string;
  noop?: string;
  skipLowValidation?: string;
  skipNoChangeUpdates?: string;
  matchFailuresAsNew?: string;
  cataloger?: string;
  fixType?: string;
}

export default async ({sruUrl, amqpUrl, mongoUri, pollWaitTime, recordType, requireAuthForRead, requireKVPForWrite, fixTypes, allowedLibs: _allowedLibs}: { // eslint-disable-line @typescript-eslint/no-unused-vars -- accepted in the config shape, not used here
  sruUrl: string;
  amqpUrl: string;
  mongoUri: string;
  pollWaitTime: number;
  recordType: string;
  requireAuthForRead: boolean;
  requireKVPForWrite: boolean;
  fixTypes: string[];
  allowedLibs: string[];
}) => {
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

  async function readResource(req: Request, res: Response, next: NextFunction) {
    logger.debug(`Request from ${(req.user as Cataloger | undefined)?.id || 'N/A'}`);
    logger.silly('routes/Prio readResource');
    try {

      const type = getType();
      const {record} = await Service.read({id: req.params['id'] as string, format: getConversionFormat(type)});

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

  async function createResource(req: Request, res: Response, next: NextFunction) {
    logger.debug(`Request from ${(req.user as Cataloger | undefined)?.id || 'N/A'}`);
    logger.silly('routes/Prio createResource');
    try {

      const conversionFormat = getConversionFormat(req.headers['content-type']);
      const correlationId = uuid();
      const queryParams = req.query as unknown as PrioQueryParams;
      const user = req.user as Cataloger;

      const operationSettings = {
        unique: queryParams.unique === undefined ? true : parseBoolean(queryParams.unique),
        merge: queryParams.merge === undefined ? false : parseBoolean(queryParams.merge),
        noop: parseBoolean(queryParams.noop),
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

  async function updateResource(req: Request, res: Response, next: NextFunction) {
    logger.debug(`Request from ${(req.user as Cataloger | undefined)?.id || 'N/A'}`);
    logger.silly('routes/Prio updateResource');
    try {
      const conversionFormat = getConversionFormat(req.headers['content-type']);
      const correlationId = uuid();
      const queryParams = req.query as unknown as PrioQueryParams;
      const user = req.user as Cataloger;

      const operationSettings = {
        // unique is n/a for updates
        unique: null,
        merge: queryParams.merge === undefined ? false : parseBoolean(queryParams.merge),
        noop: parseBoolean(queryParams.noop),
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
        id: req.params['id'] as string,
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

  async function fixResource(req: Request, res: Response, next: NextFunction) {
    logger.debug(`Request from ${(req.user as Cataloger | undefined)?.id || 'N/A'}`);
    logger.silly('routes/Prio fixResource');
    try {
      const correlationId = uuid();
      const queryParams = req.query as unknown as PrioQueryParams;
      const user = req.user as Cataloger;

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
        noop: parseBoolean(queryParams.noop),
        // Prio always validates
        validate: true,
        prio: true
      };

      const {messages, id} = await Service.fix({
        id: req.params['id'] as string,
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

  async function getPrioLogs(req: Request, res: Response, next: NextFunction) {
    logger.debug(`Request from ${(req.user as Cataloger | undefined)?.id || 'N/A'}`);
    logger.silly('routes/Prio doQuery');
    try {
      const response = await Service.doQuery(req.query as unknown as Record<string, string | undefined>);
      res.json(response);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  function getConversionFormat(type: string | undefined) {
    const {conversionFormat} = (CONTENT_TYPES.find(({contentType}) => contentType === type)) as (typeof CONTENT_TYPES)[number];
    return conversionFormat;
  }


};
