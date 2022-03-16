import httpStatus from 'http-status';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import {CONTENT_TYPES2} from '../config';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {version as uuidVersion, validate as uuidValidate} from 'uuid';

const logger = createLogger();

export function authorizeKVPOnly(req, res, next) {
  if (req.user.authorization.includes('KVP')) {
    return next();
  }

  return res.status(httpStatus.FORBIDDEN).send('User credentials do not have permission to use this endpoint');
}

export function sanitizeCataloger(passportCataloger, queryCataloger) {
  const {id, authorization} = passportCataloger;

  if (authorization.includes('KVP') && queryCataloger) {
    return {id: queryCataloger, authorization};
  }

  if (!authorization.includes('KVP') && queryCataloger !== undefined) { // eslint-disable-line functional/no-conditional-statement
    throw new HttpError(httpStatus.FORBIDDEN, 'Account has no permission to do this request');
  }

  return {id, authorization};
}

// Note: checkAcceptHeader currently works only for prio
export function checkAcceptHeader(req, res, next) {
  logger.debug(`routesUtils:checkAcceptHeader: accept: ${req.headers.accept}`);
  if (req.headers.accept === undefined || !CONTENT_TYPES2.find(({contentType, allowPrio}) => contentType === req.headers.accept && allowPrio === true)) {
    return res.status(httpStatus.UNSUPPORTED_MEDIA_TYPE).send('Invalid Accept header');
  }

  return next();
}

export function checkId(req, res, next) {
  logger.debug(`routesUtils:checkId: id: ${req.params.id}`);
  if (!uuidValidate(req.params.id) || uuidVersion(req.params.id) !== 4) {
    return res.status(httpStatus.BAD_REQUEST).send('Malformed correlation id');
  }

  return next();
}

export function checkContentType(req, res, next) {
  logger.debug(`routesUtils:checkContentType: content-type: ${req.headers['content-type']}`);

  const result = req.headers['content-type'] === undefined ? undefined : CONTENT_TYPES2.find(({contentType}) => contentType === req.headers['content-type']);
  logger.debug(`routesUtils:checkContentType: Found defined contentType: ${JSON.stringify(result)}`);

  if ((/^\/bulk[/?]/u).test(req.originalUrl)) {
    logger.debug(`Checking contentType for bulk (${req.originalUrl}`);
    if (!result || result.allowBulk === false) {
      return res.status(httpStatus.UNSUPPORTED_MEDIA_TYPE).send('Invalid content-type');
    }
    return next();
  }

  logger.debug(`Checking contentType for prio (${req.originalUrl}`);

  logger.debug('Checking contentType for prio');
  if (!result || result.allowPrio === false) {
    return res.status(httpStatus.UNSUPPORTED_MEDIA_TYPE).send('Invalid content-type');
  }

  return next();
}
