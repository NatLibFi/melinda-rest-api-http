import {Router} from 'express';
import bodyParser from 'body-parser';
import httpStatus from 'http-status';
import {v4 as uuid} from 'uuid';
import {createLogger} from '@natlibfi/melinda-commons';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import {OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import createService from '../interfaces/bulk.ts';
import {authorizeKVPOnly, checkId, checkContentType} from './routeUtils.ts';
import {checkQueryParams} from './queryUtils.ts';
import {inspect} from 'util';
import type {NextFunction, Request, Response} from 'express';
import type {Cataloger} from './routeUtils.ts';
import type {BulkCreateQueryResult, BulkQueryParams} from '../interfaces/bulk.ts';

export default async function ({mongoUri, amqpUrl, recordType, allowedLibs}: {mongoUri: string, amqpUrl: string, recordType: string, allowedLibs: string[]}) {
  const logger = createLogger();

  const OPERATION_TYPES: string[] = [OPERATIONS.CREATE, OPERATIONS.UPDATE];
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

  async function create(req: Request, res: Response, next: NextFunction) {
    try {
      logger.silly('routes/Bulk create');
      // DEVELOP: why we pass req.user.id here?
      const user = req.user as Cataloger;
      const queryParams = req.query as unknown as BulkQueryParams;
      // @ts-expect-error second arg (req.user.id) is ignored at runtime by validateQueryParams
      const {operation, recordLoadParams, noStream, operationSettings} = (Service.validateQueryParams(queryParams, req.user.id)) as BulkCreateQueryResult;

      // We have match and merge settings just for bib records in validator
      if (recordType !== 'bib' && (operationSettings.unique || operationSettings.merge)) {
        throw new HttpError(httpStatus.BAD_REQUEST, `Unique and merge can only be used for bib records, use unique=0`);
      }

      const params = {
        correlationId: uuid(),
        cataloger: Service.checkCataloger(user.id, queryParams.pCatalogerIn),
        oCatalogerIn: user.id,
        // the checkContentType middleware guarantees a defined content-type here
        contentType: req.headers['content-type'] as string,
        operation,
        recordLoadParams,
        operationSettings,
        stream: noStream ? undefined : req
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

  async function addRecordToBulk(req: Request, res: Response, next: NextFunction) {
    logger.debug('routes/Bulk addRecordToBulk');

    try {
      const correlationId = req.params['id'] as string;
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

  async function addRecordsToBulk(req: Request, res: Response, next: NextFunction) {
    logger.debug('routes/Bulk addRecordsToBulk');

    try {
      const correlationId = req.params['id'] as string;
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


  async function doQuery(req: Request, res: Response, next: NextFunction) {
    try {
      logger.silly('routes/Bulk doQuery');
      const response = await Service.doQuery(req.query as unknown as Record<string, string | undefined>);
      res.json(response);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  async function getState(req: Request, res: Response, next: NextFunction) {
    logger.debug('routes/Bulk getState');
    try {
      logger.silly('routes/Bulk getState');
      logger.silly(`We have a correlationId: ${req.params['id']}`);
      const response = await Service.getState({correlationId: req.params['id'] as string});
      res.status(response.status).json(response.payload);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  async function updateState(req: Request, res: Response, next: NextFunction) {
    logger.debug('routes/Bulk updateStatus');
    try {
      const {state} = (Service.validateQueryParams(req.query as unknown as BulkQueryParams)) as {state: string};
      const response = await Service.updateState({correlationId: req.params['id'] as string, state});
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
  async function readContent(req: Request, res: Response, next: NextFunction) {
    try {
      logger.silly('routes/Bulk readContent');
      const {contentType, readStream} = await Service.readContent(req.params['id'] as string);
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

  async function remove(req: Request, res: Response, next: NextFunction) {
    logger.silly('routes/Bulk remove');
    try {
      const response = await Service.remove({oCatalogerIn: (req.user as Cataloger).id, correlationId: req.params['id'] as string});
      // commons 7 remove returns {removed, deletedContent} - passed through as-is
      res.json({request: req.query, result: response});
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }

      return next(error);
    }
  }

  async function removeContent(req: Request, res: Response, next: NextFunction) {
    logger.silly('routes/Bulk removeContent');
    try {
      await Service.removeContent({oCatalogerIn: (req.user as Cataloger).id, correlationId: req.params['id'] as string});
      res.sendStatus(204);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }

      return next(error);
    }
  }
}
