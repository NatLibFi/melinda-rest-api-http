import httpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {version as uuidVersion, validate as uuidValidate} from 'uuid';

const logger = createLogger();

export function checkQueryParams(req, res, next) {
  const queryParams = req.query;
  logger.debug(`Checking query params: ${JSON.stringify(queryParams)}`);
  const failedParams = [
    {name: 'id', value: queryParams.id ? uuidValidate(req.params.id) && uuidVersion(req.params.id) === 4 : true},
    {name: 'pOldNew', value: queryParams.pOldNew ? (/^NEW|OLD$/u).test(queryParams.pActiveLibrary) : true},
    {name: 'pActiveLibrary', value: queryParams.pActiveLibrary ? (/^FIN\d\d$/u).test(queryParams.pActiveLibrary) : true},
    {name: 'noStream', value: queryParams.noStream ? (/^0|1$/u).test(queryParams.noop) : true},
    {name: 'noop', value: queryParams.noop ? (/^0|1$/u).test(queryParams.noop) : true},
    {name: 'unique', value: queryParams.unique ? (/^0|1$/u).test(queryParams.unique) : true},
    {name: 'merge', value: queryParams.merge ? (/^0|1$/u).test(queryParams.merge) : true},
    {name: 'validate', value: queryParams.validate ? (/^0|1$/u).test(queryParams.validate) : true},
    {name: 'failOnError', value: queryParams.failOnError ? (/^0|1$/u).test(queryParams.failOnError) : true},
    {name: 'pRejectFile', value: queryParams.pRejectFile ? (/^[a-z|A-Z|0-9|/|\-|.]{0,50}$/u).test(queryParams.pCatalogerIn) : true},
    {name: 'pLogFile', value: queryParams.pLogFile ? (/^[a-z|A-Z|0-9|/|\-|.]{0,50}$/u).test(queryParams.pCatalogerIn) : true},
    {name: 'pCatalogerIn', value: queryParams.pCatalogerIn ? (/^[A-Z|0-9|_|-]{0,10}$/u).test(queryParams.pCatalogerIn) : true}
  ].filter(param => !param.value).map(param => param.name);

  if (failedParams.length === 0) {
    logger.debug('Query params OK');
    return next();
  }

  logger.error(`Failed query params: ${failedParams}`);
  return res.status(httpStatus.BAD_REQUEST).send(`BAD query params: ${failedParams}`);
}
