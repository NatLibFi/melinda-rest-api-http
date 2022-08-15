import httpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import {mongoLogFactory} from '@natlibfi/melinda-rest-api-commons';

// import {inspect} from 'util';

export default async function ({mongoUri}) {
  const logger = createLogger();
  const mongoLogOperator = await mongoLogFactory(mongoUri);

  return {doLogsQuery, getLogs, getListOfLogs, protectLog, removeLog};

  async function getLogs(params) {
    logger.debug(`getLogs: params: ${JSON.stringify(params)}`);
    logger.debug(`Getting action logs for ${params.correlationId}`);

    const result = await mongoLogOperator.queryById(params.correlationId);
    logger.silly(`Result from query: ${JSON.stringify(result)}`);

    if (!result || result.length < 1) {
      throw new HttpError(httpStatus.NOT_FOUND, `Item not found for id: ${params.correlationId}`);
    }

    return {status: httpStatus.OK, payload: result};
  }

  function doLogsQuery(incomingParams) {
    const params = generateLogQuery(incomingParams);
    // logger.debug(`Params (JSON): ${JSON.stringify(params)}`);
    // logger.debug(`Params (inspect): ${inspect(params)}`);
    const result = mongoLogOperator.query(params);
    return result;
  }

  function getListOfLogs(logItemType = 'MERGE_LOG') {
    return mongoLogOperator.getListOfLogs(logItemType);
  }

  function protectLog(correlationId, blobSequence) {
    return mongoLogOperator.protect(correlationId, blobSequence);
  }

  function removeLog(correlationId, force = false) {
    return mongoLogOperator.remove(correlationId, force);
  }
}