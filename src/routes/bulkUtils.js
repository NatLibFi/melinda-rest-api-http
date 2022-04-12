import httpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {version as uuidVersion, validate as uuidValidate} from 'uuid';
import {QUEUE_ITEM_STATE} from '@natlibfi/melinda-rest-api-commons';

const logger = createLogger();

export function checkQueryParams(req, res, next) {
  const queryParams = req.query;
  logger.debug(`Checking query params: ${JSON.stringify(queryParams)}`);
  const failedParams = [
    {name: 'id', value: queryParams.id ? uuidValidate(queryParams.id) && uuidVersion(queryParams.id) === 4 : true},
    {name: 'pOldNew', value: queryParams.pOldNew ? (/^(?<pOldNew>NEW|OLD)$/u).test(queryParams.pOldNew) : true},
    {name: 'pActiveLibrary', value: queryParams.pActiveLibrary ? (/^FIN\d\d$/u).test(queryParams.pActiveLibrary) : true},
    {name: 'noStream', value: queryParams.noStream ? (/^0|1$/u).test(queryParams.noStream) : true},
    {name: 'noop', value: queryParams.noop ? (/^0|1$/u).test(queryParams.noop) : true},
    {name: 'unique', value: queryParams.unique ? (/^0|1$/u).test(queryParams.unique) : true},
    {name: 'merge', value: queryParams.merge ? (/^0|1$/u).test(queryParams.merge) : true},
    {name: 'validate', value: queryParams.validate ? (/^0|1$/u).test(queryParams.validate) : true},
    {name: 'failOnError', value: queryParams.failOnError ? (/^0|1$/u).test(queryParams.failOnError) : true},
    {name: 'pRejectFile', value: queryParams.pRejectFile ? (/^[a-z|A-Z|0-9|/|\-|.]{0,50}$/u).test(queryParams.pRejectFile) : true},
    {name: 'pLogFile', value: queryParams.pLogFile ? (/^[a-z|A-Z|0-9|/|\-|.]{0,50}$/u).test(queryParams.pLogFile) : true},
    {name: 'pCatalogerIn', value: queryParams.pCatalogerIn ? (/^[A-Z|0-9|_|-]{0,10}$/u).test(queryParams.pCatalogerIn) : true},
    {name: 'creationTime', value: queryParams.creationTime ? checkTimeFormat(queryParams.creationTime) : true},
    {name: 'modificationTime', value: queryParams.modificationTime ? checkTimeFormat(queryParams.modificationTime) : true},
    {name: 'queueItemState', value: queryParams.queueItemState ? checkQueueItemState(queryParams.queueItemState) : true},
    {name: 'skip', value: queryParams.skip ? (/^\d{1,7}$/u).test(queryParams.skip) : true},
    {name: 'limit', value: queryParams.limit ? (/^\d{1,7}$/u).test(queryParams.limit) : true}
  ].filter(param => !param.value).map(param => param.name);

  if (failedParams.length === 0) {
    logger.debug('Query params OK');
    return next();
  }

  logger.error(`Failed query params: ${failedParams}`);
  return res.status(httpStatus.BAD_REQUEST).json({error: 'BAD query params', failedParams});

  function checkTimeFormat(timestampArrayString) {
    if (!(/^\[.*\]$/u).test(timestampArrayString)) {
      return false;
    }

    const timestampArray = JSON.parse(timestampArrayString);
    timestampArray.filter(timestamp => {
      if ((/^\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}T[0-2]{1}\d{1}:[0-6]{1}\d{1}:[0-6]{1}\d{1}\.\d{3}Z/u).test(timestamp)) {
        return true;
      }

      if ((/^\d{4}-[01]{1}\d{1}-[0-3]{1}\d{1}$/u).test(timestamp)) {
        return true;
      }

      return false;
    });

    if (timestampArray.length < 1 || timestampArray.length > 2) {
      return false;
    }

    return true;
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
}
