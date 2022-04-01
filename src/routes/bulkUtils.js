import httpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {version as uuidVersion, validate as uuidValidate} from 'uuid';

const logger = createLogger();

export function checkQueryParams(req, res, next) {
    const queryParams = req.query;
    logger.debug(`Checking query params: ${JSON.stringify(queryParams)}`);
    const failedParams = [
        id = queryParams.id ? uuidValidate(req.params.id) && uuidVersion(req.params.id) === 4 : true,
        pOldNew = queryParams.pOldNew ? /^NEW|OLD$/u.test(queryParams.pActiveLibrary) : true,
        pActiveLibrary = queryParams.pActiveLibrary ? /^FIN\d\d$/u.test(queryParams.pActiveLibrary) : true,
        noStream = queryParams.noStream ? /^0|1$/u.test(queryParams.noop) : true,
        noop = queryParams.noop ? /^0|1$/u.test(queryParams.noop) : true,
        unique = queryParams.unique ? /^0|1$/u.test(queryParams.unique) : true,
        merge = queryParams.merge ? /^0|1$/u.test(queryParams.merge) : true,
        validate = queryParams.validate ? /^0|1$/u.test(queryParams.validate) : true,
        failOnError = queryParams.failOnError ? /^0|1$/u.test(queryParams.failOnError) : true,
        pRejectFile = queryParams.pRejectFile ? /^[a-z|A-Z|0-9|/|\-|.]{0,50}$/u.test(queryParams.pCatalogerIn) : true,
        pLogFile = queryParams.pLogFile ? /^[a-z|A-Z|0-9|/|\-|.]{0,50}$/u.test(queryParams.pCatalogerIn) : true,
        pCatalogerIn = queryParams.pCatalogerIn ? /^[A-Z|0-9|_|\-]{0,10}$/u.test(queryParams.pCatalogerIn) : true
    ].filter(param => !param);

    if (failedParams.length === 0) {
        logger.debug('Query params OK');
        return next();
    }

    logger.error(`Failed query params: ${failedParams}`);
    return res.status(httpStatus.BAD_REQUEST).send(`BAD query params: ${failedParams}`);
}
