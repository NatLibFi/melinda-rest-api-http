import httpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {version as uuidVersion, validate as uuidValidate} from 'uuid';
import {QUEUE_ITEM_STATE, LOG_ITEM_TYPE} from '@natlibfi/melinda-rest-api-commons';

const logger = createLogger();

export function checkQueryParams(req, res, next) {
  const queryParams = req.query;

  logger.debug(`Checking query params: ${JSON.stringify(queryParams)}`);
  const failedParams = [
    {name: 'id', value: queryParams.id ? uuidValidate(queryParams.id) && uuidVersion(queryParams.id) === 4 : true},
    // correlationId is checked as LogQueryParameters below
    //{name: 'correlationId', value: queryParams.correlationId ? uuidValidate(queryParams.correlationId) && uuidVersion(queryParams.correlationId) === 4 : true},
    {name: 'pOldNew', value: queryParams.pOldNew ? (/^(?<pOldNew>NEW|OLD)$/u).test(queryParams.pOldNew) : true},
    {name: 'pActiveLibrary', value: queryParams.pActiveLibrary ? (/^FIN\d\d$/u).test(queryParams.pActiveLibrary) : true},
    {name: 'noStream', value: queryParams.noStream ? (/^(?:1|0|true|false)$/ui).test(queryParams.noStream) : true},
    {name: 'noop', value: queryParams.noop ? (/^(?:1|0|true|false)$/ui).test(queryParams.noop) : true},
    {name: 'unique', value: queryParams.unique ? (/^(?:1|0|true|false)$/ui).test(queryParams.unique) : true},
    {name: 'merge', value: queryParams.merge ? (/^(?:1|0|true|false)$/ui).test(queryParams.merge) : true},
    {name: 'validate', value: queryParams.validate ? (/^(?:1|0|true|false)$/ui).test(queryParams.validate) : true},
    {name: 'failOnError', value: queryParams.failOnError ? (/^(?:1|0|true|false)$/ui).test(queryParams.failOnError) : true},
    {name: 'skipNoChangeUpdates', value: queryParams.skipNoChangeUpdates ? (/^(?:1|0|true|false)$/ui).test(queryParams.skipNoChangeUpdates) : true},
    {name: 'pRejectFile', value: queryParams.pRejectFile ? (/^[a-z|A-Z|0-9|/|.|_|-]{0,100}$/u).test(queryParams.pRejectFile) : true},
    {name: 'pLogFile', value: queryParams.pLogFile ? (/^[a-z|A-Z|0-9|/|.|_|-]{0,100}$/u).test(queryParams.pLogFile) : true},
    {name: 'pCatalogerIn', value: queryParams.pCatalogerIn ? (/^(?:0|false|undefined|[A-Z|0-9|_|-]{0,10}$)/u).test(queryParams.pCatalogerIn) : true},
    {name: 'creationTime', value: queryParams.creationTime ? checkTimeFormat(queryParams.creationTime) : true},
    {name: 'modificationTime', value: queryParams.modificationTime ? checkTimeFormat(queryParams.modificationTime) : true},
    {name: 'queueItemState', value: queryParams.queueItemState ? checkQueueItemState(queryParams.queueItemState) : true},
    ...checkLogQuerryParams(queryParams),
    ...checkLimitAndSkip(queryParams),
    ...checkShowParams(queryParams),
    ...checkRecordReportParams(queryParams)
  ].filter(param => !param.value).map(param => param.name);

  const nonCompatibleParams = checkNonCompatibleParams(queryParams);

  if (failedParams.length === 0 && nonCompatibleParams.length === 0) {
    logger.debug('Query params OK');
    return next();
  }

  logger.error(`Failed query params: ${failedParams}, ${nonCompatibleParams}`);
  //const combinedFailedParams = [...failedParams, ...nonCompatibleParams];
  return res.status(httpStatus.BAD_REQUEST).json({error: 'BAD query params', failedParams, nonCompatibleParams});

  function checkNonCompatibleParams(queryParams) {
    if (queryParams.id !== undefined && queryParams.correlationId !== undefined && queryParams.id !== queryParams.correlationId) {
      return ['correlationId', 'id'];
    }
    return [];
  }

  function checkLogQuerryParams(queryParams) {
    return [
      {name: 'correlationId', value: queryParams.correlationId ? uuidValidate(queryParams.correlationId) && uuidVersion(queryParams.correlationId) === 4 : true},
      {name: 'logItemType', value: queryParams.logItemType ? checkLogItemType(queryParams.logItemType) : true},
      {name: 'blobSequence', value: queryParams.blobSequence ? (/^[0-9]{1,5}$/u).test(queryParams.blobSequence) : true},
      {name: 'standardIdentifiers', value: queryParams.standardIdentifiers ? (/^[a-z|A-Z|0-9|/|.|_|-]{0,50}$/u).test(queryParams.standardIdentifiers) : true},
      {name: 'databaseId', value: queryParams.databaseId ? (/^[0-9]{9}$/u).test(queryParams.databaseId) : true},
      {name: 'sourceIds', value: queryParams.sourceIds ? (/^\([A-Z|0-9|_|-]{0,10}\)[A-Z|0-9|_|-]{0,20}$/u).test(queryParams.sourceIds) : true},
      {name: 'force', value: queryParams.force ? (/^(?:1|0|true|false)$/ui).test(queryParams.force) : true},
      {name: 'expanded', value: queryParams.expanded ? (/^(?:1|0|true|false)$/ui).test(queryParams.expanded) : true},
      // catalogers has comma-separated list of catalogers (1-10 word characters each)
      {name: 'catalogers', value: queryParams.catalogers ? (/^[A-Z|0-9|_|-]{1,10}(?:,[A-Z|0-9|_|-]{1,10})*$/ui).test(queryParams.catalogers) : true},
      {name: 'logItemTypes', value: queryParams.logItemTypes ? !queryParams.logItemTypes.split(',').some(logItemType => !checkLogItemType(logItemType)) : true}
    ];
  }

  function checkLimitAndSkip(queryParams) {
    return [
      {name: 'skip', value: queryParams.skip ? (/^\d{1,7}$/u).test(queryParams.skip) : true},
      {name: 'limit', value: queryParams.limit ? (/^\d{1,7}$/u).test(queryParams.limit) : true}
    ];
  }

  function checkTimeFormat(timestampArrayString) {
    if (!(/^\[.*\]$/u).test(timestampArrayString)) {
      return false;
    }
    logger.debug(`TimestampArrayString: ${timestampArrayString}`);
    try {
      const timestampArray = JSON.parse(timestampArrayString);
      const invalidTimestamps = timestampArray.some(timestamp => {
        if ((/^\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}T[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}\.\d{3}Z/u).test(timestamp)) {
          return false;
        }

        if ((/^\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}$/u).test(timestamp)) {
          return false;
        }

        return true;
      });

      if (invalidTimestamps) {
        return false;
      }

      return true;
    } catch (err) {
      logger.debug(`Parsing timestampArrayString ${timestampArrayString} failed: ${err.message}`);
      return false;
    }
  }

  function checkQueueItemState(queueItemState) {

    const states = {
      ...QUEUE_ITEM_STATE.VALIDATOR,
      ...QUEUE_ITEM_STATE.IMPORTER,
      DONE: QUEUE_ITEM_STATE.DONE,
      ERROR: QUEUE_ITEM_STATE.ERROR,
      ABORT: QUEUE_ITEM_STATE.ABORT
    };
    return states[queueItemState];
  }

  function checkLogItemType(logItemType) {
    const logItemTypes = LOG_ITEM_TYPE;

    if (logItemTypes[logItemType]) {
      return true;
    }

    return false;
  }

  function checkShowParams(queryParams) {
    return [
      {name: 'showAll', value: queryParams.showAll ? (/^(?:1|0|true|false)$/ui).test(queryParams.showAll) : true},
      {name: 'showOperations', value: queryParams.showOperations ? (/^(?:1|0|true|false)$/ui).test(queryParams.showOperations) : true},
      {name: 'showOperationSettings', value: queryParams.showOperationSettings ? (/^(?:1|0|true|false)$/ui).test(queryParams.showOperationSettings) : true},
      {name: 'showRecordLoadParams', value: queryParams.showRecordLoadParams ? (/^(?:1|0|true|false)$/ui).test(queryParams.showRecordLoadParams) : true},
      {name: 'showImportJobState', value: queryParams.showImportJobState ? (/^(?:1|0|true|false)$/ui).test(queryParams.showImportJobState) : true}
    ];
  }

  function checkRecordReportParams(queryParams) {
    return [
      {name: 'recordsAsReport', value: queryParams.recordsAsReport ? (/^(?:1|0|true|false)$/ui).test(queryParams.recordsAsReport) : true},
      {name: 'noRecords', value: queryParams.noRecords ? (/^(?:1|0|true|false)$/ui).test(queryParams.noRecords) : true},
      {name: 'noIds', value: queryParams.noIds ? (/^(?:1|0|true|false)$/ui).test(queryParams.noIds) : true}
    ];
  }

}
