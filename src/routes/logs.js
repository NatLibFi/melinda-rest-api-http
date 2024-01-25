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
    .get('/catalogers', getListOfCatalogers)
    .get('/correlationIds', getListOfCorrelationIds)
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

  // routes/getLogs -> interfaces -> getLogs -> mongoLog queryByIds
  // DEVELOP: currently return *one MERGE_LOG* for correlationId if such exists
  async function getLogs(req, res, next) {
    logger.verbose('routes/logs getLogs');
    try {
      logger.debug(`We have a correlationId: ${req.params.id}`);
      const response = await Service.getLogs({correlationId: req.params.id});
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

  async function getListOfCatalogers(req, res, next) {
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


  async function getListOfCorrelationIds(req, res, next) {
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

  async function getListOfLogs(req, res, next) {
    logger.verbose('routes/logs getListOfLogs');
    logger.debug(`query: ${JSON.stringify(req.query)}`);
    const getExpanded = req.query?.expanded ? parseBoolean(req.query.expanded) : false;
    const logItemType = req.query?.logItemType ? req.query.logItemType : undefined;
    try {
      const response = getExpanded ? await Service.getExpandedListOfLogs(req.query) : await Service.getListOfLogs(logItemType);
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

  async function protectLog(req, res, next) {
    logger.verbose('routes/logs protectLog');
    try {
      const correlationId = req.params.id;
      const {blobSequence} = req.query || false;
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

  async function removeLog(req, res, next) {
    logger.verbose('routes/logs removeLog');
    try {
      const correlationId = req.params.id;
      const {force} = req.query || 0;
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
