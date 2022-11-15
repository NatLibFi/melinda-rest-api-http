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

  function generateLogQuery(queryParams) {
    const {
      correlationId: queryCorrelationId,
      logItemType: queryLogItemType,
      blobSequence: queryBlobSequence,
      standardIdentifiers: queryStandardIdentifiers,
      databaseId: queryDatabaseId,
      sourceIds: querySourceIds,
      skip: querySkip,
      limit: queryLimit,
      ...rest
    } = queryParams;

    // Format blobSequence* parameters from strings to numbers
    // Create blobSequenceStart and blobSequenceEnd from blobSequence
    const correlationIdObj = queryCorrelationId ? {correlationId: queryCorrelationId} : {};
    const logItemTypeObj = queryLogItemType ? {logItemType: queryLogItemType} : {};
    const blobSequenceObj = queryBlobSequence ? {blobSequence: Number(queryBlobSequence)} : {};
    const standardIdentifiersObj = queryStandardIdentifiers ? {standardIdentifiers: queryStandardIdentifiers} : {};
    const databaseIdObj = queryDatabaseId ? {databaseId: queryDatabaseId} : {};
    const sourceIdsObj = querySourceIds ? {sourceIds: querySourceIds} : {};
    const skip = querySkip ? {skip: Number(querySkip)} : {};
    const limit = queryLimit ? {limit: Number(queryLimit)} : {};

    const newParams = {
      ...correlationIdObj,
      ...logItemTypeObj,
      ...blobSequenceObj,
      ...standardIdentifiersObj,
      ...databaseIdObj,
      ...sourceIdsObj,
      ...skip,
      ...limit,
      ...rest
    };

    return newParams;
  }
}
