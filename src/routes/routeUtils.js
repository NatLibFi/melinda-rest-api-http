import httpStatus from 'http-status';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import {CONTENT_TYPES} from '../config';

export function authorizeKVPOnly(req, res, next) {
  if (req.user.authorization.includes('KVP')) {
    return next();
  }

  return res.status(httpStatus.FORBIDDEN).send('User creditianls do not have permission to use this endpoint');
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
  if (req.headers.Accept === undefined || !CONTENT_TYPES[req.headers.Accept]) {
    return res.status(httpStatus.UNSUPPORTED_MEDIA_TYPE).send('Invalid Accept header');
  }

  return next();
}

export function checkContentType(req, res, next) {
  if (req.headers['content-type'] === undefined || !CONTENT_TYPES[req.headers['content-type']]) {
    return res.status(httpStatus.UNSUPPORTED_MEDIA_TYPE).send('Invalid content-type');
  }

  return next();
}
