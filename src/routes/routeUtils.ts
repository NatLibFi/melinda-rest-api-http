import httpStatus from 'http-status';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import {CONTENT_TYPES} from '../config.ts';
import {createLogger} from '@natlibfi/melinda-commons';
import {version as uuidVersion, validate as uuidValidate} from 'uuid';
import type {NextFunction, Request, Response} from 'express';

const logger = createLogger();

/**
 * The authenticated cataloger as forwarded by passport: the passport
 * user's id and the authorization groups of the account.
 */
export interface Cataloger {
  id: string;
  authorization: string | string[];
}

export function authorizeKVPOnly(req: Request, res: Response, next: NextFunction) {
  const user = req.user as Cataloger;
  logger.debug(`Checking ${JSON.stringify(user.id)} for KVP-authorization: ${user.authorization}`);
  if (user.authorization.includes('KVP')) {
    logger.debug(`We have user with KVP-authorization`);
    return next();
  }

  return res.status(httpStatus.FORBIDDEN).send('User credentials do not have permission to use this endpoint');
}

export function sanitizeCataloger(passportCataloger: Cataloger, queryCataloger: string | undefined) {
  const {id, authorization} = passportCataloger;

  // Handle nullValue -strings as undefined
  const nullValuePattern = /^(?<nullValues>0|false|null|undefined)$/ui;
  const cleanedQueryCataloger = queryCataloger === undefined || nullValuePattern.test(queryCataloger) ? undefined : queryCataloger;

  logger.debug(`QueryCataloger: ${queryCataloger} -> cleanedQueryCataloger: ${cleanedQueryCataloger}`);

  // KVP-users can use random strings as cataloger-ids
  if (authorization.includes('KVP') && cleanedQueryCataloger) {
    return {id: cleanedQueryCataloger, authorization};
  }

  // Non-KVP-users cannot use random strings as cataloger-ids
  if (!authorization.includes('KVP') && cleanedQueryCataloger !== undefined && cleanedQueryCataloger !== id) {
    throw new HttpError(httpStatus.FORBIDDEN, 'Account has no permission to do this request');
  }

  // No Cataloger given in parameters
  return {id, authorization};
}

// Note: checkAcceptHeader currently works only for prio
// Note: checkAcceptHeader always errors if accept-header has several accepted types

export function checkAcceptHeader(req: Request, res: Response, next: NextFunction) {
  logger.debug(`routesUtils:checkAcceptHeader: accept: ${req.headers.accept}`);

  if (req.headers.accept === '*/*') {
    return next();
  }

  if (req.headers.accept === undefined || !CONTENT_TYPES.find(({contentType, allowPrio}) => contentType === req.headers.accept && allowPrio === true)) {
    return res.status(httpStatus.UNSUPPORTED_MEDIA_TYPE).send('Invalid Accept header');
  }

  return next();
}

export function checkId(req: Request, res: Response, next: NextFunction) {
  logger.debug(`routesUtils:checkId: id: ${req.params['id']}`);
  if (!uuidValidate(req.params['id'] as string) || uuidVersion(req.params['id'] as string) !== 4) {
    return res.status(httpStatus.BAD_REQUEST).send('Malformed correlation id');
  }

  return next();
}

export function checkContentType(req: Request, res: Response, next: NextFunction) {
  logger.debug(`routesUtils:checkContentType: content-type: ${req.headers['content-type']}`);

  const result = req.headers['content-type'] === undefined ? undefined : CONTENT_TYPES.find(({contentType}) => contentType === req.headers['content-type']);
  logger.debug(`routesUtils:checkContentType: Found defined contentType: ${JSON.stringify(result)}`);

  if ((/^\/records[/?]/u).test(req.originalUrl)) {
    logger.debug(`Checking contentType for addRecords (path: ${req.originalUrl})`);
    if (!result || result.allowAddRecords === false) {
      return res.status(httpStatus.UNSUPPORTED_MEDIA_TYPE).send('Invalid content-type');
    }
    return next();
  }

  if ((/^\/bulk[/?]/u).test(req.originalUrl)) {
    logger.debug(`Checking contentType for bulk (path: ${req.originalUrl})`);
    if (!result || result.allowBulk === false) {
      return res.status(httpStatus.UNSUPPORTED_MEDIA_TYPE).send('Invalid content-type');
    }
    return next();
  }

  logger.debug(`Checking contentType for prio (path: ${req.originalUrl})`);
  if (!result || result.allowPrio === false) {
    return res.status(httpStatus.UNSUPPORTED_MEDIA_TYPE).send('Invalid content-type');
  }

  return next();
}
