import httpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import {mongoLogFactory} from '@natlibfi/melinda-rest-api-commons';
import {LOG_ITEM_TYPE} from '@natlibfi/melinda-rest-api-commons/dist/constants';

// import {inspect} from 'util';

export default async function ({mongoUri}) {
  const logger = createLogger();
  const mongoLogOperator = await mongoLogFactory(mongoUri);

  return {getLogs, doLogsQuery, getListOfCatalogers, getListOfCorrelationIds, getListOfLogs, getExpandedListOfLogs, protectLog, removeLog};

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

  function getListOfCatalogers() {
    return mongoLogOperator.getListOfCatalogers();
  }

  // This is used nowhere?
  function getListOfLogs(logItemType = LOG_ITEM_TYPE.MERGE_LOG) {
    return mongoLogOperator.getListOfLogs(logItemType);
  }

  function getListOfCorrelationIds() {
    return mongoLogOperator.getListOfCorrelationIds();
  }

  // default to MERGE_LOG if no logItemType is given
  function getExpandedListOfLogs({expanded = 'false', logItemType = LOG_ITEM_TYPE.MERGE_LOG, logItemTypes = false, catalogers = false, creationTime = false}) {
    const getExpanded = parseBoolean(expanded);
    logger.debug(`getExpandedListOfLogs`);
    if (getExpanded) {
      logger.debug(`Getting expanded list of logs`);
      const getLogItemTypes = logItemTypes ? logItemTypes.split(',') : [logItemType];
      const getCatalogers = catalogers ? catalogers.split(`,`) : undefined;
      const creationTimeArray = creationTime ? JSON.parse(creationTime) : [];
      const dateAfter = creationTimeArray[0] || '2000-01-01';
      const dateBefore = creationTimeArray[1] || new Date().toISOString();
      logger.debug(`logItemTypes: [${getLogItemTypes}], dateAfter: ${dateAfter}, dateBefore: ${dateBefore}}, catalogers: [${getCatalogers}]`);
      return mongoLogOperator.getExpandedListOfLogs({logItemTypes: getLogItemTypes, catalogers: getCatalogers, dateAfter, dateBefore});
    }

    logger.debug(`Getting list of logs ${logItemType}`);
    if (LOG_ITEM_TYPE[logItemType]) {
      return getListOfLogs(logItemType);
    }

    throw new HttpError(httpStatus.BAD_REQUEST, 'Invalid logItemType');
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
    // blobSequence should be *number* in Mongo!
    const blobSequenceObj = queryBlobSequence ? {blobSequence: Number(queryBlobSequence)} : {};
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
