import httpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import {mongoLogFactory} from '@natlibfi/melinda-rest-api-commons';
import {LOG_ITEM_TYPE} from '@natlibfi/melinda-rest-api-commons/dist/constants.js';

// import {inspect} from 'util';

export interface LogsQueryParams {
  correlationId?: string;
  id?: string;
  logItemType?: string;
  blobSequence?: string;
  standardIdentifiers?: string;
  databaseId?: string;
  sourceIds?: string;
  skip?: string;
  limit?: string;
}

export interface ExpandedLogQueryParams {
  expanded?: string | false;
  logItemType?: string;
  logItemTypes?: string | false;
  catalogers?: string | false;
  creationTime?: string | false;
}

export default async function ({mongoUri}: {mongoUri: string}) {
  const logger = createLogger();
  const mongoLogOperator = await mongoLogFactory(mongoUri);

  return {getLogs, doLogsQuery, getListOfCatalogers, getListOfCorrelationIds, getListOfLogs, getExpandedListOfLogs, protectLog, unprotectLog, toggleLog, removeLog};

  // routes/getLogs -> interfaces -> getLogs -> mongoLog queryByIds
  // DEVELOP: currently return *one MERGE_LOG* for correlationId if such exists
  // getLogs reads *just* correlationId, and returns one MERGE_LOG for it
  // this is kinda useless
  async function getLogs(params: {correlationId: string}) {
    logger.debug(`getLogs: params: ${JSON.stringify(params)}`);
    logger.debug(`Getting action logs for ${params.correlationId}`);

    const result = await mongoLogOperator.queryById(params.correlationId);
    logger.silly(`Result from query: ${JSON.stringify(result)}`);

    if (!result || result.length < 1) {
      throw new HttpError(httpStatus.NOT_FOUND, `Item not found for id: ${params.correlationId}`);
    }

    return {status: httpStatus.OK, payload: result};
  }

  function doLogsQuery(incomingParams: LogsQueryParams) {
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
  function getListOfLogs(logItemType: string = LOG_ITEM_TYPE.MERGE_LOG) {
    return mongoLogOperator.getListOfLogs(logItemType);
  }

  function getListOfCorrelationIds() {
    return mongoLogOperator.getListOfCorrelationIds();
  }

  // default to MERGE_LOG if no logItemType is given
  function getExpandedListOfLogs({expanded = 'false', logItemType = LOG_ITEM_TYPE.MERGE_LOG, logItemTypes = false, catalogers = false, creationTime = false}: ExpandedLogQueryParams) {
    const getExpanded = parseBoolean(expanded as string);
    logger.debug(`getExpandedListOfLogs`);
    if (getExpanded) {
      logger.debug(`Getting expanded list of logs`);
      const getLogItemTypes = logItemTypes ? logItemTypes.split(',') : [logItemType];
      const getCatalogers = catalogers ? catalogers.split(`,`) : undefined;
      const creationTimeArray = creationTime ? JSON.parse(creationTime as string) : [];
      const dateAfter = creationTimeArray[0] || '2000-01-01';
      const dateBefore = creationTimeArray[1] || new Date().toISOString();
      logger.debug(`logItemTypes: [${getLogItemTypes}], dateAfter: ${dateAfter}, dateBefore: ${dateBefore}}, catalogers: [${getCatalogers}]`);
      return mongoLogOperator.getExpandedListOfLogs({logItemTypes: getLogItemTypes, catalogers: getCatalogers, dateAfter, dateBefore});
    }

    logger.debug(`Getting list of logs ${logItemType}`);
    if ((Object.values(LOG_ITEM_TYPE) as readonly string[]).includes(logItemType)) {
      return getListOfLogs(logItemType);
    }

    throw new HttpError(httpStatus.BAD_REQUEST, 'Invalid logItemType');
  }

  // commons 7 protect is protect-only (no toggle): already-protected docs
  // stay protected
  function protectLog(correlationId: string, blobSequence?: string | number) {
    return mongoLogOperator.protect(correlationId, blobSequence);
  }

  function unprotectLog(correlationId: string, blobSequence?: string | number) {
    return mongoLogOperator.unprotect(correlationId, blobSequence);
  }

  // commons 7 protect/unprotect are one-directional (no toggle), so the
  // legacy v5 toggle behavior (each matching doc flips its protected value)
  // is re-created here on top of them
  async function toggleLog(correlationId: string, blobSequence?: string | number) {
    logger.verbose(`toggleLog: correlationId: ${correlationId}, blobSequence: ${blobSequence}`);
    // query() defaults to limit 5; toggle must see every matching doc
    const docs = await mongoLogOperator.query({correlationId, limit: Number.MAX_SAFE_INTEGER});
    // the operator stores blobSequence as a number, so compare parsed values
    const wanted = blobSequence === undefined ? docs : docs.filter((doc) => doc.blobSequence === parseInt(String(blobSequence), 10));
    logger.debug(`toggleLog: matched ${wanted.length} log item(s) for correlationId: ${correlationId}`);
    if (wanted.length === 0) {
      // mirror the updateMany result of a filter matching nothing (field
      // order matches the real UpdateResult's JSON serialization)
      return {acknowledged: true, modifiedCount: 0, upsertedId: null, upsertedCount: 0, matchedCount: 0};
    }
    const allProtected = wanted.every((doc) => doc.protected === true);
    const allUnprotected = wanted.every((doc) => !doc.protected);
    if (allProtected || allUnprotected) {
      const response = allProtected ? await unprotectLog(correlationId, blobSequence) : await protectLog(correlationId, blobSequence);
      logger.debug(`toggleLog: toggled all docs with a single ${allProtected ? 'unprotect' : 'protect'} call`);
      return response;
    }
    // mixed protected values: flip each doc individually
    let matchedCount = 0;
    let modifiedCount = 0;
    let flippedCount = 0;
    const processedSequences = new Set<number>();
    for (const doc of wanted) {
      // protect()/unprotect() target by blobSequence, so a doc without a valid
      // sequence can't be flipped individually (undefined would flip the whole
      // correlationId, diverging from the v5 toggle); it keeps its current value
      if (typeof doc.blobSequence !== 'number' || !Number.isInteger(doc.blobSequence) || doc.blobSequence <= 0) {
        logger.warn(`toggleLog: skipping doc without a valid blobSequence (${String(doc.blobSequence)}) for correlationId ${correlationId}; it keeps its current protected value`);
        continue;
      }
      // each per-doc call targets by blobSequence, so docs sharing one sequence
      // are flipped only once
      if (processedSequences.has(doc.blobSequence)) {
        continue;
      }
      processedSequences.add(doc.blobSequence);
      logger.debug(`toggleLog: flipping doc with blobSequence: ${doc.blobSequence}, protected: ${Boolean(doc.protected)}`);
      const response = doc.protected ? await unprotectLog(correlationId, doc.blobSequence) : await protectLog(correlationId, doc.blobSequence);
      matchedCount += response.matchedCount;
      modifiedCount += response.modifiedCount;
      flippedCount += 1;
    }
    logger.debug(`toggleLog: flipped ${flippedCount} doc(s) individually (${wanted.length} matched)`);
    return {acknowledged: true, modifiedCount, upsertedId: null, upsertedCount: 0, matchedCount};
  }

  function removeLog(correlationId: string, force = false) {
    return mongoLogOperator.remove(correlationId, force);
  }

  function generateLogQuery(queryParams: LogsQueryParams) {
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
      ...limit
      // ...rest is deliberately not spread: the query object is passed
      // directly to a Mongo filter, so unknown client-supplied keys could
      // otherwise inject query operators ($-keys) or nested field paths
    };

    const unknownKeys = Object.keys(rest);
    if (unknownKeys.length > 0) {
      logger.debug(`generateLogQuery: ignoring unknown query params: ${unknownKeys.join(', ')}`);
    }

    return newParams;
  }
}
