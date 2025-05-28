import {Router} from 'express';
import {inspect} from 'util';
import passport from 'passport';
import {v4 as uuid} from 'uuid';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import createService from '../interfaces/prio';
import httpStatus from 'http-status';
import {authorizeKVPOnly, checkContentType, sanitizeCataloger} from './routeUtils';
import {checkQueryParams, getOperationSettingsForPrio, checkAcceptHeaderForPrio, getTypes, getConversionFormat} from './queryUtils';
import {OPERATIONS} from '@natlibfi/melinda-rest-api-commons/';

export default async ({sruUrl, amqpUrl, mongoUri, pollWaitTime, requireAuthForRead, requireKVPForWrite, fixTypes, allowedLibs}) => {
  const logger = createLogger();
  // Note: prio Service doesn'y know allowedLibs!
  const Service = await createService({
    sruUrl, amqpUrl, mongoUri, pollWaitTime, allowedLibs
  });

  //logger.debug(`Read: ${requireAuthForRead} write: ${requireKVPForWrite}`);
  // Require KVP authentication for creates/updates if requireKVPForWrite is true
  // Note: this also requires general authentication for read

  if (requireKVPForWrite) {
    logger.verbose(`Requiring authentication for reading and KVP authentication for writing`);
    return new Router()
      .use(passport.authenticate('melinda', {session: false}))
      .use(checkQueryParams)
      .get('/:id', checkAcceptHeaderForPrio, readResource)
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
      .get('/:id', checkAcceptHeaderForPrio, readResource)
      .get('/prio/', authorizeKVPOnly, getPrioLogs)
      .post('/fix/:id', fixResource)
      .post('/', checkContentType, createResource)
      .post('/:id', checkContentType, updateResource);
  }

  //logger.verbose(`Requiring authentication only for writing`);
  return new Router()
    .use(checkQueryParams)
    .get('/:id', checkAcceptHeaderForPrio, readResource)
    .use(passport.authenticate('melinda', {session: false}))
    .get('/prio/', authorizeKVPOnly, getPrioLogs)
    .post('/fix/:id', fixResource)
    .post('/', checkContentType, createResource)
    .post('/:id', checkContentType, updateResource);

  async function readResource(req, res, next) {
    logger.debug(`Read request from ${req?.user?.id || 'N/A'}`);
    logger.silly('routes/Prio readResource');
    try {

      const types = getTypes(req.headers.accept);
      const [type] = types;
      logger.debug(`Using first contentType: ${type} from ${JSON.stringify(types)}`);
      const {record} = await Service.read({id: req.params.id, format: getConversionFormat(type)});

      return res.type(type).status(httpStatus.OK)
        .send(record);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }


  }

  async function createResource(req, res, next) {
    logger.debug(`Request from ${req?.user?.id || 'N/A'}`);
    logger.silly('routes/Prio createResource');

    try {

      const correlationId = uuid();
      const conversionFormat = getConversionFormat(req.headers['content-type']);
      const operationSettings = getOperationSettingsForPrio({queryParams: req.query, settings: {operation: OPERATIONS.CREATE}});

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

      buildResponseForCreate({messages, id, status, operationSettings});

    } catch (error) {
      if (error instanceof HttpError) {
        logger.debug(`${JSON.stringify(error)}`);
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }

    function buildResponseForCreate({messages, id, status, operationSettings}) {

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
      return res.status(httpStatus.OK).json(messages);
    }
  }

  async function updateResource(req, res, next) {
    logger.debug(`Request from ${req?.user?.id || 'N/A'}`);
    logger.silly('routes/Prio updateResource');
    try {
      const conversionFormat = getConversionFormat(req.headers['content-type']);
      const correlationId = uuid();

      const operationSettings = getOperationSettingsForPrio({queryParams: req.query, settings: {operation: OPERATIONS.UPDATE}});

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
        // Note: skipLowValidation does not currently work - fixes are not validated
        // skipLowValidation: req.query.skipLowValidation === undefined ? false : parseBoolean(req.query.skipLowValidation),
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

};
