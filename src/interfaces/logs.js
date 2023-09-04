import httpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import {mongoLogFactory} from '@natlibfi/melinda-rest-api-commons';

// import {inspect} from 'util';

export default async function ({mongoUri}) {
  const logger = createLogger();
  const mongoLogOperator = await mongoLogFactory(mongoUri);

  return {doLogsQuery, getLogs, getListOfLogs, getExpandedListOfLogs, protectLog, removeLog};

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
    logger.debug(`Incoming params (JSON): ${JSON.stringify(incomingParams)}`);
    const params = generateLogQuery(incomingParams);
    logger.debug(`Params (JSON): ${JSON.stringify(params)}`);
    // logger.debug(`Params (inspect): ${inspect(params)}`);
    const result = mongoLogOperator.query(params);
    return result;
  }

  function getListOfLogs(logItemType = 'MERGE_LOG') {
    return mongoLogOperator.getListOfLogs(logItemType);
  }

  function getExpandedListOfLogs() {
    return mongoLogOperator.getExpandedListOfLogs();
  }

  function protectLog(correlationId, blobSequence) {
    return mongoLogOperator.protect(correlationId, blobSequence);
  }

  function removeLog(correlationId, force = false) {
    return mongoLogOperator.remove(correlationId, force);
  }

  function generateLogQuery(queryParams) {
    logger.debug(`generateLogQuery: queryParams: ${JSON.stringify(queryParams)}`);
    const {
      correlationId: queryCorrelationId,
      id: queryId,
      logItemType: queryLogItemType,
      blobSequence: queryBlobSequence,
      standardIdentifiers: queryStandardIdentifiers,
      databaseId: queryDatabaseId,
      sourceIds: querySourceIds,
      skip: querySkip,
      limit: queryLimit,
      ...rest
    } = queryParams;

    logger.debug(`queryCorrelationId: ${queryCorrelationId}, queryId: ${queryId}`);

    // Use id if we do not have correlationId
    const queryCombinedId = queryCorrelationId === undefined ? queryId : queryCorrelationId;

    logger.debug(`queryCombinedId: ${queryCombinedId}`);

    // DEVELOP: Format blobSequence* parameters from strings to numbers
    // DEVELOP: Create blobSequenceStart and blobSequenceEnd from blobSequence
    const correlationIdObj = queryCombinedId ? {correlationId: queryCombinedId} : {};
    const logItemTypeObj = queryLogItemType ? {logItemType: queryLogItemType} : {};
    //const blobSequenceObj = queryBlobSequence ? {blobSequence: Number(queryBlobSequence)} : {};
    // blobSequence is (currently) a string in Mongo!
    const blobSequenceObj = queryBlobSequence ? {blobSequence: queryBlobSequence} : {};
    const standardIdentifiersObj = queryStandardIdentifiers ? {standardIdentifiers: queryStandardIdentifiers} : {};
    const databaseIdObj = queryDatabaseId ? {databaseId: queryDatabaseId} : {};
    const sourceIdsObj = querySourceIds ? {sourceIds: querySourceIds} : {};
    // skip and limit work
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
