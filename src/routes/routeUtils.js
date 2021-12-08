import httpStatus from 'http-status';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import {CONTENT_TYPES} from '../config';
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

export function checkAcceptHeader(req, res, next) {
  logger.debug(`routesUtils:checkAcceptHeader: accept: ${req.headers.accept}`);
  if (req.headers.accept === undefined || !CONTENT_TYPES.prio[req.headers.accept]) {
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
  if ((/^\/bulk\//u).test(req.originalUrl)) {
    if (req.headers['content-type'] === undefined || !CONTENT_TYPES.bulk.includes(req.headers['content-type'])) {
      return res.status(httpStatus.UNSUPPORTED_MEDIA_TYPE).send('Invalid content-type');
    }

    return next();
  }
  if (req.headers['content-type'] === undefined || !CONTENT_TYPES.prio[req.headers['content-type']]) {
    return res.status(httpStatus.UNSUPPORTED_MEDIA_TYPE).send('Invalid content-type');
  }

  return next();
}
