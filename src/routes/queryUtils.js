import httpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {version as uuidVersion, validate as uuidValidate} from 'uuid';
import {QUEUE_ITEM_STATE, LOG_ITEM_TYPE, OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import {allowedLibs, defaultLibrary, recordType, CONTENT_TYPES, DEFAULT_ACCEPT} from '../config.js';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';

const logger = createLogger();

// checkQueryParams
// validateQueryParamsForCreateAndUpdate: bulk && prioChunk - operationSettings etc
// checkCataloger

// eslint-disable-next-line complexity
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
    {name: 'skipLowValidation', value: queryParams.skipLowValidation ? (/^(?:1|0|true|false)$/ui).test(queryParams.skipLowValidation) : true},
    {name: 'failOnError', value: queryParams.failOnError ? (/^(?:1|0|true|false)$/ui).test(queryParams.failOnError) : true},
    {name: 'skipNoChangeUpdates', value: queryParams.skipNoChangeUpdates ? (/^(?:1|0|true|false)$/ui).test(queryParams.skipNoChangeUpdates) : true},
    {name: 'maatchFailuresAsNew', value: queryParams.matchFailuresAsNew ? (/^(?:1|0|true|false)$/ui).test(queryParams.matchFailuresAsNew) : true},
    {name: 'pRejectFile', value: queryParams.pRejectFile ? (/^[a-z|A-Z|0-9|/|.|_|-]{0,100}$/u).test(queryParams.pRejectFile) : true},
    {name: 'pLogFile', value: queryParams.pLogFile ? (/^[a-z|A-Z|0-9|/|.|_|-]{0,100}$/u).test(queryParams.pLogFile) : true},
    {name: 'pCatalogerIn', value: queryParams.pCatalogerIn ? (/^(?:0|false|undefined|[A-Z|0-9|_|-]{0,10}$)/u).test(queryParams.pCatalogerIn) : true},
    {name: 'creationTime', value: queryParams.creationTime ? checkTimeFormat(queryParams.creationTime) : true},
    {name: 'modificationTime', value: queryParams.modificationTime ? checkTimeFormat(queryParams.modificationTime) : true},
    {name: 'queueItemState', value: queryParams.queueItemState ? checkQueueItemState(queryParams.queueItemState) : true},
    {name: 'fixType', value: queryParams.fixType ? (/^(?:0|false|undefined|[A-Z|0-9|_|-]{0,10}$)/u).test(queryParams.fixType) : true},
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

// query parameters for bulk and prioChunk creates and updates
export function validateQueryParamsForCreateAndUpdate({queryParams, settings = {}}) {
  // queryParams from request from user
  logger.debug(`bulk/validateQueryParamsForCreateAndUpdate: queryParams: ${JSON.stringify(queryParams)}`);
  // settings from API itself
  logger.debug(`bulk/validateQueryParamsForCreateAndUpdate: settings: ${JSON.stringify(settings)}`);

  const pActiveLibrary = handlePActiveLibrary(queryParams.pActiveLibrary);
  const {operation, pOldNew} = handleOperationAndPOldNew(settings.operation, queryParams.pOldNew);
  const noStream = handleNoStream(queryParams.noStream, settings.noStream);
  const updatedSettings = {
    ...settings,
    prio: settings.prio === undefined ? false : settings.prio
  };

  const operationSettings = handleOperationSettings({queryParams, noStream, settings: updatedSettings});

  const recordLoadParams = {
    pActiveLibrary,
    pOldNew,
    pRejectFile: queryParams.pRejectFile || null,
    pLogFile: queryParams.pLogFile || null,
    pCatalogerIn: queryParams.pCatalogerIn || null
  };

  logger.debug(`operation: ${operation}, recordLoadParameters: ${JSON.stringify(recordLoadParams)}, noStream: ${noStream}, operationSettings: ${JSON.stringify(operationSettings)}`);
  return {operation, recordLoadParams, noStream, operationSettings};


  function handleNoStream(queryNoStream, settingsNoStream) {
    logger.debug(`Handling noStream from query '${queryNoStream}' and from API ${settingsNoStream}`);

    if (queryNoStream === undefined && settingsNoStream === undefined) {
      // noStream defaults to false
      return false;
    }

    if (queryNoStream !== undefined && settingsNoStream === undefined) {
      return parseBoolean(queryNoStream);
    }

    if (queryNoStream === undefined && settingsNoStream !== undefined) {
      return settingsNoStream;
    }

    if (queryNoStream !== undefined && settingsNoStream !== undefined) {
      if (settingsNoStream === parseBoolean(queryNoStream)) {
        return settingsNoStream;
      }
      throw new HttpError(httpStatus.BAD_REQUEST, `Invalid noStream parameter '${queryNoStream}'`);
    }
    throw new HttpError(httpStatus.INTERNAL_SERVER_ERROR, `Something wrong with noStream from query '${queryNoStream}' and from API ${settingsNoStream}`);
  }

  function handlePActiveLibrary(pActiveLibrary) {
    // use default_library if we do not have pActiveLibrary from query - is this a risk?
    if (!pActiveLibrary) {
      logger.debug(`No pActiveLibrary parameter using default library ${defaultLibrary}`);
      return defaultLibrary;
    }

    // Note: for backwards compatibility, if we have default empty allowedLibs, we do not check lib here (aleph-record-load-api handles it later)
    if (allowedLibs.length > 0 && !allowedLibs.includes(pActiveLibrary)) {
      logger.debug(`Invalid pActiveLibrary parameter '${pActiveLibrary} - not included in ${JSON.stringify(allowedLibs)}`);
      throw new HttpError(httpStatus.BAD_REQUEST, `Invalid pActiveLibrary parameter '${pActiveLibrary}'`);
    }

    return pActiveLibrary;
  }

  function handleOperationAndPOldNew(operation, pOldNew) {
    // If we do not get pOldNew from queryParams, let's get in from operation
    // should we be able to get operation from queryParameters (instead of pOldNew)?
    logger.debug(`operation from API: ${operation}, pOldNew from user: ${pOldNew}`);

    if (operation === undefined && pOldNew === undefined) {
      throw new HttpError(httpStatus.BAD_REQUEST, 'Missing mandatory query parameter pOldNew');
    }

    if (pOldNew !== undefined && !['NEW', 'OLD'].includes(pOldNew)) {
      logger.debug(`bulk/validateQueryParamsForCreateAndUpdate: invalid pOldNew: ${JSON.stringify(pOldNew)}`);
      throw new HttpError(httpStatus.BAD_REQUEST, `Invalid pOldNew query parameter '${pOldNew}'. (Valid values: OLD/NEW)`);
    }

    /*
        if (queryOperation !== undefined && ![OPERATIONS.CREATE, OPERATIONS.UPDATE].includes(queryOperation)) {
          logger.debug(`bulk/validateQueryParamsForCreateAndUpdate: invalid operation from query: ${JSON.stringify(operation)}`);
          throw new HttpError(httpStatus.BAD_REQUEST, `Invalid operation parameter '${operation}'. (Valid values: UPDATE/CREATE)`);
        }
      */

    if (operation !== undefined && ![OPERATIONS.CREATE, OPERATIONS.UPDATE].includes(operation)) {
      logger.debug(`bulk/validateQueryParamsForCreateAndUpdate: invalid operation from API itself: ${JSON.stringify(operation)}`);
      throw new HttpError(httpStatus.INTERNAL_SERVER_ERROR, `Invalid operation '${operation}'.`);
    }

    if (operation === undefined || pOldNew === undefined) {
      logger.debug(`No comparison needed, operation or pOldNew undefined. Operation: '${operation}' pOldNew: '${pOldNew}'`);
      return {
        operation: operation === undefined ? getOperationFromPOldNew(pOldNew) : operation,
        pOldNew: pOldNew === undefined ? getPOldNewFromOperation(operation) : pOldNew
      };
    }

    if (operation === OPERATIONS.CREATE && pOldNew === 'NEW') {
      return {operation, pOldNew};
    }

    if (operation === OPERATIONS.UPDATE && pOldNew === 'OLD') {
      return {operation, pOldNew};
    }

    throw new HttpError(httpStatus.INTERNAL_SERVER_ERROR, `Invalid operation/pOldNew combination: operation: '${operation}' pOldNew: '${pOldNew}'.`);

    function getPOldNewFromOperation(operation) {
      if (operation === OPERATIONS.CREATE) {
        return 'NEW';
      }
      if (operation === OPERATIONS.UPDATE) {
        return 'OLD';
      }
    }

    function getOperationFromPOldNew(pOldNew) {
      if (pOldNew === 'NEW') {
        return OPERATIONS.CREATE;
      }
      if (pOldNew === 'OLD') {
        return OPERATIONS.UPDATE;
      }
    }
  }

  function handleOperationSettings({queryParams, noStream, settings}) {
    // NOTE: failOnError currently works on for splitting streamBulk stream to records, not for other validations
    // should these be in config.js ?

    logger.debug(`QueryParams for validating and getting operationSettings: ${JSON.stringify(queryParams)}, noStream: ${noStream}, settings: ${JSON.stringify(settings)}`);

    const paramValidate = queryParams.validate ? parseBoolean(queryParams.validate) : undefined;
    const paramUnique = queryParams.unique ? parseBoolean(queryParams.unique) : undefined;
    const paramMerge = queryParams.merge ? parseBoolean(queryParams.merge) : undefined;
    const paramSkipLowValidation = queryParams.skipLowValidation ? parseBoolean(queryParams.skipLowValidateLow) : undefined;
    const paramMatchFailuresAsNew = queryParams.matchFailuresAsNew ? parseBoolean(queryParams.matchFailuresAsNew) : undefined;

    if (paramValidate === false && (paramUnique || paramMerge)) {
      logger.debug(`Query parameter validate=0 is not valid with query parameters unique=1 and/or merge=1`);
      throw new HttpError(httpStatus.BAD_REQUEST, `Query parameter validate=0 is not valid with query parameters unique=1 and/or merge=1`);
    }

    if (paramUnique === false && paramMerge) {
      logger.debug(`Query parameter unique=0 is not valid with query parameter merge=1`);
      throw new HttpError(httpStatus.BAD_REQUEST, `Query parameter unique=0 is not valid with query parameter merge=1`);
    }

    // noStream == batchBulk:   validate & unique are as default true
    // !noStream && prio == prioChunk: validate & unique are as default true
    // !noStream == streamBulk: validate & unique are as default false

    const operationSettings = {
      noStream,
      noop: queryParams.noop === undefined ? false : parseBoolean(queryParams.noop),
      unique: paramUnique === undefined ? noStream || settings.prio : paramUnique,
      merge: paramMerge === undefined ? false : paramMerge,
      validate: paramValidate === undefined ? noStream || settings.prio : paramValidate,
      // Note: currently bulk skips LOW validation all the time, because cataloger.authorization is not forwarded in bulk
      skipLowValidation: paramSkipLowValidation === undefined ? false : paramSkipLowValidation,
      failOnError: queryParams.failOnError === undefined ? false : parseBoolean(queryParams.failOnError),
      // bulk skips changes that won't change the database record as default
      skipNoChangeUpdates: queryParams.skipNoChangeUpdates === undefined ? true : parseBoolean(queryParams.skipNoChangeUpdates),
      matchFailuresAsNew: paramMatchFailuresAsNew,
      chunk: settings.chunk,
      prio: settings.prio
    };

    return operationSettings;
  }
}

// DEVELOP: add authorization, deduplicate code (same kind of stuff in prio: sanitizeCataloger)
// Could we get cataloger also as queryParam.cataloger in addition to pCatalogerIn
export function checkCataloger(id, paramsId) {
  if (paramsId !== undefined && paramsId !== 'undefined' && paramsId !== '0' && paramsId !== 'false') {
    logger.debug(`Using cataloger given in parameters.`);
    return paramsId;
  }
  logger.debug(`No cataloger given in parameters, using user's id as cataloger.`);
  return id;
}

export function getOperationSettingsForPrio({queryParams, settings}) {

  const operationSettings = {
    unique: getUnique({queryParams, settings}),
    merge: queryParams.merge === undefined ? false : parseBoolean(queryParams.merge), // UPDATE + CREATE
    noop: parseBoolean(queryParams.noop), // UPDATE + CREATE
    // Prio always validates
    validate: true, // UPDATE + CREATE
    skipLowValidation: queryParams.skipLowValidation === undefined ? false : parseBoolean(queryParams.skipLowValidation), // UPDATE + CREATE
    // failOnError is n/a for prio single record jobs
    failOnError: null, // UPDATE + CREATE
    // Prio forces updates as default, even if the update would not make changes to the database record
    skipNoChangeUpdates: queryParams.skipNoChangeUpdates === undefined ? false : parseBoolean(queryParams.skipNoChangeUpdates), // UPDATE + CREATE
    matchFailuresAsNew: queryParams.matchFailuresAsNew === undefined ? undefined : parseBoolean(queryParams.matchFailuresAsNew), // CREATE
    prio: true // UPDATE + CREATE
  };

  // We have match and merge settings just for bib records in validator
  if (recordType !== 'bib' && (operationSettings.unique || operationSettings.merge)) {
    throw new HttpError(httpStatus.BAD_REQUEST, `Unique and merge can only be used for bib records, use unique=0`);
  }

  // Merge requires unique for CREATEs (unique in non-applicaple for UPDATEs)
  if (settings.operation === OPERATIONS.CREATE && operationSettings.merge && operationSettings.unique === false) {
    throw new HttpError(httpStatus.BAD_REQUEST, `Merge cannot be used with unique set as **false**`);
  }

  return operationSettings;

  function getUnique({queryParams, settings}) {
    if (settings?.operation === OPERATIONS.CREATE) {
      return queryParams.unique === undefined ? true : parseBoolean(queryParams.unique); // CREATE
    }
    // unique is non-applicable for UPDATEs
    return null;
  }

}


export function getConversionFormat(type) {
  logger.debug(`prio/getConversionFormat: CONTENT_TYPES: ${JSON.stringify(CONTENT_TYPES)}, type: ${JSON.stringify(type)}`);
  const {conversionFormat} = CONTENT_TYPES.find(({contentType}) => contentType === type);
  return conversionFormat;
}


export function getTypes(acceptHeaders) {
  logger.silly(`${acceptHeaders}`);

  // We can use DEFAULT_ACCEPT, if accept headers do not exist
  if (acceptHeaders === undefined) {
    logger.debug(`Accept header ${acceptHeaders}, using DEFAULT_ACCEPT: ${DEFAULT_ACCEPT}`);
    return [DEFAULT_ACCEPT];
  }

  // Accept header example: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  // DEVELOP: handle q's in accept headers, now we use just first valid type from list
  const acceptHeaderContents = acceptHeaders.split(',').map(acceptHeaderContent => acceptHeaderContent.split(';')[0]);
  logger.silly(`acceptHeaderContents: ${JSON.stringify(acceptHeaderContents)}`);

  logger.silly(`CONTENT_TYPES: ${JSON.stringify(CONTENT_TYPES)}`);

  // get valid contentTypes
  const validContentTypes = acceptHeaderContents.filter(acceptHeaderContent => CONTENT_TYPES.find(({contentType, allowPrio}) => acceptHeaderContent === contentType && allowPrio === true));
  logger.silly(`valid contentTypes: ${JSON.stringify(validContentTypes)} (${validContentTypes.length})`);

  if (validContentTypes.length > 0) {
    logger.debug(`Accept header ${acceptHeaders} contains valid types (${validContentTypes.length}): ${JSON.stringify(validContentTypes)}`);
    return validContentTypes;
  }

  // We can use DEFAULT_ACCEPT, if accept headers contain wildcard
  if (acceptHeaderContents.includes('*/*')) {
    logger.debug(`Accept header ${acceptHeaders}, contains wildcard, use DEFAULT_ACCEPT: ${DEFAULT_ACCEPT}`);
    return [DEFAULT_ACCEPT];
  }

  logger.debug(`No valid contentTypes found`);
  return [];
}

// Note: checkAcceptHeader currently works only for prio, and only for record data in succesfull request responses
// Note/DEVELOP: we are not returning asked type for errors etc.!
export async function checkAcceptHeaderForPrio(req, res, next) {
  logger.debug(`routesUtils:checkAcceptHeaderForPrio: accept: ${req.headers.accept}`);

  // Undefined accept header is okay, we'll use default type
  if (req.headers.accept === undefined) {
    return next;
  }

  const validTypes = await getTypes(req.headers.accept);
  logger.debug(`We got ${validTypes.length}: ${JSON.stringify(validTypes)} accepted types from Accept header`);

  if (validTypes.length > 0) {
    return next();
  }
  return res.status(httpStatus.UNSUPPORTED_MEDIA_TYPE).send('Invalid Accept header');
}
