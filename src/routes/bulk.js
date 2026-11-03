import {Router} from 'express';
import bodyParser from 'body-parser';
import httpStatus from 'http-status';
import {v4 as uuid} from 'uuid';
import {createLogger} from '@natlibfi/melinda-commons';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import {OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import createService from '../interfaces/bulk.js';
import {authorizeKVPOnly, checkId, checkContentType} from './routeUtils.js';
import {checkQueryParams} from './queryUtils.js';
import {inspect} from 'util';

/**
 * Flat view of the request query string (see the QueryParams note in
 * queryUtils.js).
 * @typedef {Object} BulkQueryParams
 * @property {string} [pCatalogerIn]
 */

/**
 * @param {{mongoUri: string, amqpUrl: string, recordType: string, allowedLibs: string[]}} config
 */
export default async function ({mongoUri, amqpUrl, recordType, allowedLibs}) {
  const logger = createLogger();

  const OPERATION_TYPES = [OPERATIONS.CREATE, OPERATIONS.UPDATE];
  const Service = await createService({mongoUri, amqpUrl, allowedLibs});

  return Router()
    .use(authorizeKVPOnly)
    .use(checkQueryParams)
    .get('/', doQuery)
    .get('/content/:id', checkId, readContent)
    .get('/state/:id', checkId, getState)
    .put('/state/:id', checkId, updateState)
    .delete('/:id', checkId, remove)
    .delete('/content/:id', checkId, removeContent)
    .post('/records/:id', checkContentType, checkId, bodyParser.text({limit: '5MB', type: '*/*'}), addRecordsToBulk)
    .post('/record/:id', checkContentType, checkId, bodyParser.text({limit: '5MB', type: '*/*'}), addRecordToBulk)
    .post('/', checkContentType, create);

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function create(req, res, next) {
    try {
      logger.silly('routes/Bulk create');
      // DEVELOP: why we pass req.user.id here?
      const user = /** @type {{id: string}} */(req.user);
      const queryParams = /** @type {BulkQueryParams} */(req.query);
      // @ts-expect-error second arg (req.user.id) is ignored at runtime by validateQueryParams
      const {operation, recordLoadParams, noStream, operationSettings} = /** @type {any} */(Service.validateQueryParams(queryParams, req.user.id));

      // We have match and merge settings just for bib records in validator
      if (recordType !== 'bib' && (operationSettings.unique || operationSettings.merge)) {
        throw new HttpError(httpStatus.BAD_REQUEST, `Unique and merge can only be used for bib records, use unique=0`);
      }

      const params = {
        correlationId: uuid(),
        cataloger: Service.checkCataloger(user.id, queryParams.pCatalogerIn),
        oCatalogerIn: user.id,
        contentType: req.headers['content-type'],
        operation,
        recordLoadParams,
        operationSettings,
        stream: noStream ? false : req
      };

      logger.silly('Params done');
      logger.silly(`Params: ${inspect(params)}`);
      if (params.operation && OPERATION_TYPES.includes(params.operation)) {
        const response = await Service.create(params);
        res.json(response);
        return;
      }

      logger.debug('Invalid operation');
      throw new HttpError(httpStatus.BAD_REQUEST, 'Invalid operation');
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function addRecordToBulk(req, res, next) {
    logger.debug('routes/Bulk addRecordToBulk');

    try {
      const correlationId = /** @type {string} */(req.params['id']);
      const contentType = req.headers['content-type'];
      const data = req.body;
      logger.silly(`Data from request body: ${data}`);
      const response = await Service.addRecord({correlationId, contentType, data});

      res.status(response.status).json(response.payload);
    } catch (error) {
      logger.debug('routes/Bulk addRecordToBulk - error');

      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }

      return next(error);
    }
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function addRecordsToBulk(req, res, next) {
    logger.debug('routes/Bulk addRecordsToBulk');

    try {
      const correlationId = /** @type {string} */(req.params['id']);
      const contentType = req.headers['content-type'];
      const data = req.body;
      logger.silly(`Data from request body: ${data}`);
      const response = await Service.addRecords({correlationId, contentType, data});

      res.status(response.status).json(response.payload);
    } catch (error) {
      logger.debug('routes/Bulk addRecordsToBulk - error');

      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }

      return next(error);
    }
  }


  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function doQuery(req, res, next) {
    try {
      logger.silly('routes/Bulk doQuery');
      const response = await Service.doQuery(req.query);
      res.json(response);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function getState(req, res, next) {
    logger.debug('routes/Bulk getState');
    try {
      logger.silly('routes/Bulk getState');
      logger.silly(`We have a correlationId: ${req.params['id']}`);
      const response = await Service.getState({correlationId: /** @type {string} */(req.params['id'])});
      res.status(response.status).json(response.payload);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function updateState(req, res, next) {
    logger.debug('routes/Bulk updateStatus');
    try {
      /** @type {any} */
      const {state} = Service.validateQueryParams(req.query);
      const response = await Service.updateState({correlationId: /** @type {string} */(req.params['id']), state});
      res.status(response.status).json(response.payload);
    } catch (error) {
      logger.debug('routes/Bulk updateStatus - error');
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  /* Functions after this are here only to test purposes */
  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function readContent(req, res, next) {
    try {
      logger.silly('routes/Bulk readContent');
      const {contentType, readStream} = await Service.readContent(/** @type {string} */(req.params['id']));
      res.set('content-type', contentType);
      readStream.pipe(res);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function remove(req, res, next) {
    logger.silly('routes/Bulk remove');
    try {
      const response = await Service.remove({oCatalogerIn: /** @type {{id: string}} */(req.user).id, correlationId: /** @type {string} */(req.params['id'])});
      res.json({request: req.query, result: response});
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }

      return next(error);
    }
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function removeContent(req, res, next) {
    logger.silly('routes/Bulk removeContent');
    try {
      await Service.removeContent({oCatalogerIn: /** @type {{id: string}} */(req.user).id, correlationId: /** @type {string} */(req.params['id'])});
      res.sendStatus(204);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }

      return next(error);
    }
  }
}
