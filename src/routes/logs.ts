import {Router} from 'express';
import passport from 'passport';
import {createLogger} from '@natlibfi/melinda-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import {checkQueryParams} from './queryUtils.ts';
import {authorizeKVPOnly, checkId} from './routeUtils.ts';
import createService from '../interfaces/logs.ts';
import type {NextFunction, Request, Response} from 'express';
import type {ExpandedLogQueryParams, LogsQueryParams} from '../interfaces/logs.ts';

/**
 * Flat view of the request query string (see the QueryParams note in
 * queryUtils.ts).
 */
interface LogQueryParams {
  expanded?: string;
  logItemType?: string;
}

export default async function ({mongoUri}: {mongoUri: string}) {
  const logger = createLogger();

  const Service = await createService({mongoUri});

  return Router()
    .use(passport.authenticate('melinda', {session: false}))
    .use(authorizeKVPOnly)
    .use(checkQueryParams)
    .get('/catalogers', getListOfCatalogers)
    .get('/correlationIds', getListOfCorrelationIds)
    .get('/list', getListOfLogs)
    .get('/:id', checkId, getLogs)
    .get('/', doLogsQuery)
    .put('/:id', checkId, toggleLog)
    .put('/:id/protect', checkId, protectLog)
    .put('/:id/unprotect', checkId, unprotectLog)
    .delete('/:id', checkId, removeLog);

  async function doLogsQuery(req: Request, res: Response, next: NextFunction) {
    logger.verbose('routes/logs doLogsQuery');
    try {
      logger.debug(JSON.stringify(req.query));
      const response = await Service.doLogsQuery(req.query as unknown as LogsQueryParams);
      res.json(response);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  // routes/getLogs -> interfaces -> getLogs -> mongoLog queryByIds
  // DEVELOP: currently return *one MERGE_LOG* for correlationId if such exists
  async function getLogs(req: Request, res: Response, next: NextFunction) {
    logger.verbose('routes/logs getLogs');
    try {
      logger.debug(`We have a correlationId: ${req.params['id']}`);
      const response = await Service.getLogs({correlationId: req.params['id'] as string});
      logger.debug(`Response: ${JSON.stringify(response)}`);
      //res.status(response.status).json(response.payload);
      res.json(response);
      return;
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  async function getListOfCatalogers(_req: Request, res: Response, next: NextFunction) {
    logger.verbose('routes/logs getListOfCatalogers');
    try {
      const response = await Service.getListOfCatalogers();
      logger.debug(`Response: ${JSON.stringify(response)}`);
      //res.status(response.status).json(response.payload);
      res.json(response);
      return;
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }


  async function getListOfCorrelationIds(_req: Request, res: Response, next: NextFunction) {
    logger.verbose('routes/logs getListOforrelationIds');
    try {
      const response = await Service.getListOfCorrelationIds();
      logger.debug(`Response: ${JSON.stringify(response)}`);
      //res.status(response.status).json(response.payload);
      res.json(response);
      return;
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  async function getListOfLogs(req: Request, res: Response, next: NextFunction) {
    logger.verbose('routes/logs getListOfLogs');
    logger.debug(`query: ${JSON.stringify(req.query)}`);
    const queryParams = req.query as unknown as LogQueryParams;
    const getExpanded = queryParams?.expanded ? parseBoolean(queryParams.expanded) : false;
    const logItemType = queryParams?.logItemType ? queryParams.logItemType : undefined;
    try {
      const response = getExpanded ? await Service.getExpandedListOfLogs(req.query as unknown as ExpandedLogQueryParams) : await Service.getListOfLogs(logItemType);
      logger.debug(`Response: ${JSON.stringify(response)}`);
      //res.status(response.status).json(response.payload);
      res.json(response);
      return;
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  async function toggleLog(req: Request, res: Response, next: NextFunction) {
    logger.verbose('routes/logs toggleLog');
    try {
      const correlationId = req.params['id'] as string;
      const {blobSequence} = (req.query || false) as Record<string, string | undefined>;
      logger.debug(`We have a correlationId: ${correlationId}${blobSequence ? `, blobSequence: ${blobSequence}` : ''}`);
      const response = await Service.toggleLog(correlationId, blobSequence);
      logger.debug(`We have a response: ${JSON.stringify(response)}`);
      // DEVELOP: handle response, now we just pass mongo's response on
      res.json(response);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  async function protectLog(req: Request, res: Response, next: NextFunction) {
    logger.verbose('routes/logs protectLog');
    try {
      const correlationId = req.params['id'] as string;
      const {blobSequence} = (req.query || false) as Record<string, string | undefined>;
      logger.debug(`We have a correlationId: ${correlationId}${blobSequence ? `, blobSequence: ${blobSequence}` : ''}`);
      const response = await Service.protectLog(correlationId, blobSequence);
      logger.debug(`We have a response: ${JSON.stringify(response)}`);
      // DEVELOP: handle response, now we just pass mongo's response on
      res.json(response);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  async function unprotectLog(req: Request, res: Response, next: NextFunction) {
    logger.verbose('routes/logs unprotectLog');
    try {
      const correlationId = req.params['id'] as string;
      const {blobSequence} = (req.query || false) as Record<string, string | undefined>;
      logger.debug(`We have a correlationId: ${correlationId}${blobSequence ? `, blobSequence: ${blobSequence}` : ''}`);
      const response = await Service.unprotectLog(correlationId, blobSequence);
      logger.debug(`We have a response: ${JSON.stringify(response)}`);
      // DEVELOP: handle response, now we just pass mongo's response on
      res.json(response);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  async function removeLog(req: Request, res: Response, next: NextFunction) {
    logger.verbose('routes/logs removeLog');
    try {
      const correlationId = req.params['id'] as string;
      const {force} = (req.query || 0) as Record<string, string | undefined>;
      logger.debug(`We have a correlationId: ${correlationId}`);
      const response = await Service.removeLog(correlationId, parseBoolean(force));
      // res.status(response.status).json(response.payload);
      res.json(response);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }
}

//import fs from 'fs';
//import path from 'path';
