import {Router} from 'express';
import {inspect} from 'util';
import passport from 'passport';
import {v4 as uuid} from 'uuid';
import {createLogger, OPERATION_TYPES} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import createService from '../interfaces/prio';
import {default as createBulkService} from '../interfaces/bulk';
import httpStatus from 'http-status';
import {authorizeKVPOnly, checkContentType, sanitizeCataloger} from './routeUtils';
import {CONTENT_TYPES, DEFAULT_ACCEPT} from '../config';
import {checkQueryParams} from './queryUtils';
import {OPERATIONS} from '@natlibfi/melinda-rest-api-commons/dist/constants';

export default async ({sruUrl, amqpUrl, mongoUri, pollWaitTime, recordType, requireAuthForRead, requireKVPForWrite, fixTypes, allowedLibs}) => {
  const logger = createLogger();
  const Service = await createService({
    sruUrl, amqpUrl, mongoUri, pollWaitTime
  });

  // check that we get a working mongo? is it the same here for prio and bulk?
  const prioChunkService = await createBulkService({
    mongoUri, amqpUrl, allowedLibs
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
      .post('/priochunk/create/', checkContentType, createChunkResources)
      .post('/priochunk/update/', checkContentType, updateChunkResources)
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
      .post('/priochunk/create/', checkContentType, createChunkResources)
      .post('/priochunk/update/', checkContentType, updateChunkResources)
      .post('/', checkContentType, createResource)
      .post('/:id', checkContentType, updateResource);
  }

  //logger.verbose(`Requiring authentication only for writing`);
  return new Router()
    .use(checkQueryParams)
    .get('/:id', checkAcceptHeaderForPrio, readResource)
    //.get('/apidoc/', serveApiDoc)
    .use(passport.authenticate('melinda', {session: false}))
    .get('/prio/', authorizeKVPOnly, getPrioLogs)
    .post('/fix/:id', fixResource)
    .post('/priochunk/create/', checkContentType, createChunkResources)
    .post('/priochunk/update/', checkContentType, updateChunkResources)
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

      const conversionFormat = getConversionFormat(req.headers['content-type']);
      const correlationId = uuid();

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

  function getOperationSettingsForPrio({queryParams, settings}) {

    const operationSettings = {
      unique: getUnique({queryParams, settings}),
      merge: queryParams.merge === undefined ? false : parseBoolean(queryParams.merge), // UPDATE + CREATE
      noop: parseBoolean(queryParams.noop), // UPDATE + CREATE
      // Prio always validates
      validate: true, // UPDATE + CREATE
      skipLowValidation: queryParams.skipLowValidation === undefined ? false : parseBoolean(queryParams.skipLowValidation), // UPDATE + CREATE
      // failOnError is n/a for prio single record jobs
      failOnError: null, // UPDATE + CREATE
      // Prio forces updates as default, even if the update would not make changes to the database record
      skipNoChangeUpdates: queryParams.skipNoChangeUpdates === undefined ? false : parseBoolean(queryParams.skipNoChangeUpdates), // UPDATE + CREATE
      matchFailuresAsNew: queryParams.matchFailuresAsNew === undefined ? undefined : parseBoolean(queryParams.matchFailuresAsNew), // CREATE
      prio: true // UPDATE + CREATE
    };

    // We have match and merge settings just for bib records in validator
    if (recordType !== 'bib' && (operationSettings.unique || operationSettings.merge)) {
      throw new HttpError(httpStatus.BAD_REQUEST, `Unique and merge can only be used for bib records, use unique=0`);
    }

    // Merge requires unique for CREATEs (unique in non-applicaple for UPDATEs)
    if (settings.operation === OPERATIONS.CREATE && operationSettings.merge && operationSettings.unique === false) {
      throw new HttpError(httpStatus.BAD_REQUEST, `Merge cannot be used with unique set as **false**`);
    }

    return operationSettings;

    function getUnique({queryParams, settings}) {
      if (settings?.operation === OPERATIONS.CREATE) {
        return queryParams.unique === undefined ? true : parseBoolean(queryParams.unique); // CREATE
      }
      // unique is non-applicable for UPDATEs
      return null;
    }

  }

  function createChunkResources(req, res, next) {
    return createOrUpdateResources({operation: OPERATIONS.CREATE}, req, res, next);
  }

  function updateChunkResources(req, res, next) {
    return createOrUpdateResources({operation: OPERATIONS.UPDATE}, req, res, next);
  }

  // eslint-disable-next-line max-statements
  async function createOrUpdateResources(settings, req, res, next) {
    try {
      logger.silly(`routes/prio createOrUpdateResources: settings: ${JSON.stringify(settings)}`);
      // DEVELOP: why we pass req.user.id here?
      // prioChunk is always stream
      const noStream = false;
      const prio = true;
      const chunk = true;
      // prioChunk recordLoadParams should not be available from queryParams
      // prioChunk operationSetting? we should have always validate=1 at least
      // validateAndGetOperationSettings(queryParams, noStream, prio = false, chunk = false) {
      // function validateQueryParams(queryParams, prio, chunk) {
      const {operation, recordLoadParams, operationSettings} = prioChunkService.validateQueryParams({queryParams: req.query, prio, chunk, operation: settings.operation, noStream});

      // We have match and merge settings just for bib records in validator
      if (recordType !== 'bib' && (operationSettings.unique || operationSettings.merge)) {
        throw new HttpError(httpStatus.BAD_REQUEST, `Unique and merge can only be used for bib records, use unique=0`);
      }

      const params = {
        correlationId: uuid(),
        cataloger: prioChunkService.checkCataloger(req.user.id, req.query.pCatalogerIn),
        oCatalogerIn: req.user.id,
        contentType: req.headers['content-type'],
        operation,
        recordLoadParams,
        operationSettings,
        stream: noStream ? false : req
      };

      logger.silly('Params done');
      logger.silly(`Params: ${inspect(params)}`);

      if (params.operation && !OPERATION_TYPES.includes(params.operation)) {
        logger.debug('Invalid operation');
        throw new HttpError(httpStatus.BAD_REQUEST, 'Invalid operation');
      }

      const response = await prioChunkService.create(params);
      res.json(response);
      return;

    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
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

  function getConversionFormat(type) {
    logger.debug(`prio/getConversionFormat: CONTENT_TYPES: ${JSON.stringify(CONTENT_TYPES)}, type: ${JSON.stringify(type)}`);
    const {conversionFormat} = CONTENT_TYPES.find(({contentType}) => contentType === type);
    return conversionFormat;
  }


  function getTypes(acceptHeaders) {
    logger.silly(`${acceptHeaders}`);

    // We can use DEFAULT_ACCEPT, if accept headers do not exist
    if (acceptHeaders === undefined) {
      logger.debug(`Accept header ${acceptHeaders}, using DEFAULT_ACCEPT: ${DEFAULT_ACCEPT}`);
      return [DEFAULT_ACCEPT];
    }

    // Accept header example: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    // DEVELOP: handle q's in accept headers
    const acceptHeaderContents = acceptHeaders.split(',').map(acceptHeaderContent => acceptHeaderContent.split(';')[0]);
    logger.silly(`acceptHeaderContents: ${JSON.stringify(acceptHeaderContents)}`);

    logger.silly(`CONTENT_TYPES: ${JSON.stringify(CONTENT_TYPES)}`);

    // get valid contentTypes
    const validContentTypes = acceptHeaderContents.filter(acceptHeaderContent => CONTENT_TYPES.find(({contentType, allowPrio}) => acceptHeaderContent === contentType && allowPrio === true));
    logger.silly(`valid contentTypes: ${JSON.stringify(validContentTypes)} (${validContentTypes.length})`);

    if (validContentTypes.length > 0) {
      logger.debug(`Accept header ${acceptHeaders} contains valid types (${validContentTypes.length}): ${JSON.stringify(validContentTypes)}`);
      return validContentTypes;
    }

    // We can use DEFAULT_ACCEPT, if accept headers contain wildcard
    if (acceptHeaderContents.includes('*/*')) {
      logger.debug(`Accept header ${acceptHeaders}, contains wildcard, use DEFAULT_ACCEPT: ${DEFAULT_ACCEPT}`);
      return [DEFAULT_ACCEPT];
    }

    logger.debug(`No valid contentTypes found`);
    return [];
  }

  // Note: checkAcceptHeader currently works only for prio, and only for record data in succesfull request responses
  // Note/DEVELOP: we are not returning asked type for errors etc.!
  async function checkAcceptHeaderForPrio(req, res, next) {
    logger.debug(`routesUtils:checkAcceptHeader: accept: ${req.headers.accept}`);

    // Undefined accept header is okay, we'll use default type
    if (req.headers.accept === undefined) {
      return next;
    }

    const acceptableTypes = await getTypes(req.headers.accept);
    logger.debug(`We got ${acceptableTypes.length}: ${JSON.stringify(acceptableTypes)} accepted types from Accept header`);

    if (acceptableTypes.length > 0) {
      return next();
    }
    return res.status(httpStatus.UNSUPPORTED_MEDIA_TYPE).send('Invalid Accept header');
  }


};
