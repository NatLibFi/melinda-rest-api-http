import {Router} from 'express';
import {inspect} from 'util';
//import passport from 'passport';
import {v4 as uuid} from 'uuid';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import createService from '../interfaces/prio.js';
import httpStatus from 'http-status';
import {authorizeKVPOnly, checkContentType} from './routeUtils.js';
import {checkQueryParams, checkCataloger, validateQueryParamsForCreateAndUpdate} from './queryUtils.js';
import {OPERATIONS} from '@natlibfi/melinda-rest-api-commons';

export default async ({sruUrl, amqpUrl, mongoUri, pollWaitTime, recordType, requireKVPForWrite, allowedLibs}) => {
  const logger = createLogger();
  // Note: prio Service doesn'y know allowedLibs!
  const Service = await createService({
    sruUrl, amqpUrl, mongoUri, pollWaitTime, allowedLibs
  });

  if (requireKVPForWrite) {
    logger.verbose(`Requiring KVP authentication for writing`);
    return new Router()
      .use(checkQueryParams)
      .post('/create', authorizeKVPOnly, checkContentType, createChunkResources)
      .post('/update', authorizeKVPOnly, checkContentType, updateChunkResources);
  }

  return new Router()
    .use(checkQueryParams)
    .post('/create', checkContentType, createChunkResources)
    .post('/update', checkContentType, updateChunkResources);

  function createChunkResources(req, res, next) {
    logger.debug(`priochunk/create`);
    return createOrUpdateResources({operation: OPERATIONS.CREATE}, req, res, next);
  }

  function updateChunkResources(req, res, next) {
    logger.debug(`priochunk/update`);
    return createOrUpdateResources({operation: OPERATIONS.UPDATE}, req, res, next);
  }

  // eslint-disable-next-line max-statements
  async function createOrUpdateResources(settings, req, res, next) {
    logger.debug(`priochunk/createOrUpdateResources`);
    try {
      logger.silly(`routes/prio createOrUpdateResources: settings: ${JSON.stringify(settings)}`);
      // prioChunk is always stream
      const noStream = false;
      const prio = true;
      const chunk = true;
      // prioChunk recordLoadParams should not be available from queryParams
      // prioChunk operationSetting? we should have always validate=1 at least
      // validateAndGetOperationSettings({queryParams, settings: {noStream, prio, chunk, operation}) {
      // function validateQueryParamsForCreateAndUpdate({queryParams, settings: {prio, chunk, operation, noStream}) {
      const {operation, recordLoadParams, operationSettings} = validateQueryParamsForCreateAndUpdate({queryParams: req.query, settings: {prio, chunk, operation: settings.operation, noStream}});

      // We have match and merge settings just for bib records in validator
      if (recordType !== 'bib' && (operationSettings.unique || operationSettings.merge)) {
        throw new HttpError(httpStatus.BAD_REQUEST, `Unique and merge can only be used for bib records, use unique=0`);
      }

      const params = {
        correlationId: uuid(),
        cataloger: checkCataloger(req.user.id, req.query.pCatalogerIn),
        // Should we use whole cataloger with authorizations?
        oCatalogerIn: req.user.id,
        contentType: req.headers['content-type'],
        operation,
        recordLoadParams,
        operationSettings,
        // NOTE: we need a req that has been NOT body parsered in app.js to send a stream forward!
        stream: noStream ? false : req
      };

      logger.silly('Params done');
      logger.silly(`Params: ${inspect(params)}`);

      if (params.operation && ![OPERATIONS.CREATE, OPERATIONS.UPDATE].includes(params.operation)) {
        logger.debug('Invalid operation');
        throw new HttpError(httpStatus.BAD_REQUEST, 'Invalid operation');
      }

      const response = await Service.createOrUpdateChunk(params);
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

};
