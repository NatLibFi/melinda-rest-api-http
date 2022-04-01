import httpStatus from 'http-status';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import {createLogger} from '@natlibfi/melinda-backend-commons';

const logger = createLogger();

export function authorizeKVPOnly(req, res, next) {
    const queryParams = req.query
    queryParams.pOldNew ? /^(NEW|OLD)$/u.test(queryParams.pActiveLibrary)
    queryParams.pActiveLibrary ? /^FIN\d\d$/u.test(queryParams.pActiveLibrary) : false
    queryParams.noop ? parseBoolean(queryParams.noop) : false,
    queryParams.unique ? parseBoolean(queryParams.unique) : false,
    queryParams.merge ? parseBoolean(queryParams.merge) : false,
    queryParams.validate ? parseBoolean(queryParams.validate) : false,
    queryParams.failOnError ? parseBoolean(queryParams.failOnError) : false,
    queryParams.pActiveLibrary,
    queryParams.pRejectFile || null,
    queryParams.pLogFile || null,
    queryParams.pCatalogerIn || null

    req.query
    noStream,
  };

  const noStream = queryParams.noStream ? parseBoolean(queryParams.noStream) : false;

      req.user.id,
      req.query.pCatalogerIn





  if (req.user.authorization.includes('KVP')) {
    return next();
  }

  return res.status(httpStatus.FORBIDDEN).send('User credentials do not have permission to use this endpoint');
}