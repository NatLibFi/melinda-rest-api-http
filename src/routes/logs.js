import {checkQueryParams} from "./queryUtils";
import {authorizeKVPOnly, checkId} from "./routeUtils";
import createService from '../interfaces/logs';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {parseBoolean} from "@natlibfi/melinda-commons";

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
        return res.status(error.status).send(error.payload);;
      }
    }
  }

  async function getListOfLogs(req, res, next) {
    logger.verbose('routes/logs getListOfLogs');
    try {
      const {logItemType} = req.query || 'MERGE_LOG';
      const response = await Service.getListOfLogs(skip);
      res.status(response.status).json(response.payload);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).send(error.payload);;
      }
    }
  }

  async function protectLog(req, res, next) {
    logger.verbose('routes/logs protectLog');
    try {
      const correlationId = req.params.id;
      const {blobSequence} = req.query || false;
      logger.debug(`We have a correlationId: ${correlationId}${blobSequence ? `, blobSequence: ${blobSequence}` : ''}`);
      const response = await Service.removeLog(correlationId, blobSequence);
      res.status(response.status).json(response.payload);
    } catch (error) {
      return res.status(error.status).send(error.payload);
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
      return res.status(error.status).send(error.payload);
    }
  }
}