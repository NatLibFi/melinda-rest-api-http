import {Router} from 'express';
import passport from 'passport';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import {checkQueryParams} from './queryUtils';
import {authorizeKVPOnly, checkId} from './routeUtils';
import createService from '../interfaces/logs';

export default async function ({mongoUri}) {
  const logger = createLogger();

  const Service = await createService({mongoUri});

  return new Router()
    .use(passport.authenticate('melinda', {session: false}))
    .use(authorizeKVPOnly)
    .use(checkQueryParams)
    .get('/list', getListOfLogs)
    .get('/:id', checkId, getLogs)
    .get('/', doLogsQuery)
    .put('/:id', checkId, protectLog)
    .delete('/:id', checkId, removeLog);

  async function doLogsQuery(req, res, next) {
    logger.verbose('routes/logs doLogsQuery');
    try {
      logger.debug(JSON.stringify(req.query));
      const response = await Service.doLogsQuery(req.query);
      res.json(response);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).send(error.payload);
        return;
      }
      return next(error);
    }
  }

  async function getLogs(req, res, next) {
    logger.verbose('routes/logs getLogs');
    try {
      logger.debug(`We have a correlationId: ${req.params.id}`);
      const response = await Service.getLogs({correlationId: req.params.id});
      res.status(response.status).json(response.payload);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  async function getListOfLogs(req, res, next) {
    logger.verbose('routes/logs getListOfLogs');
    try {
      const expanded = req.query === undefined || req.query.expanded === undefined ? false : parseBoolean(req.query.expanded);
      // default to MERGE_LOG if no logItemType is given
      const logItemType = req.query === undefined || req.query.logItemType === undefined ? 'MERGE_LOG' : req.query.logItemType;
      if (expanded !== true) {
        logger.debug(`Getting list of logs ${logItemType}`);
        const response = await Service.getListOfLogs(logItemType);
        res.status(response.status).json(response.payload);
        return;
      }
      logger.debug(`Getting expanded list of logs`);
      const response = await Service.getExpandedListOfLogs();
      res.status(response.status).json(response.payload);
      return;
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  async function protectLog(req, res, next) {
    logger.verbose('routes/logs protectLog');
    try {
      const correlationId = req.params.id;
      const {blobSequence} = req.query || false;
      logger.debug(`We have a correlationId: ${correlationId}${blobSequence ? `, blobSequence: ${blobSequence}` : ''}`);
      const response = await Service.protectLog(correlationId, blobSequence);
      res.status(response.status).json(response.payload);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }

  async function removeLog(req, res, next) {
    logger.verbose('routes/logs removeLog');
    try {
      const correlationId = req.params.id;
      const {force} = req.query || 0;
      logger.debug(`We have a correlationId: ${correlationId}`);
      const response = await Service.removeLog(correlationId, parseBoolean(force));
      res.status(response.status).json(response.payload);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);
      }
      return next(error);
    }
  }
}
