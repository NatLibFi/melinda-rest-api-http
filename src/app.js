import bodyParser from 'body-parser';
import express from 'express';
import httpStatus from 'http-status';
import passport from 'passport';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {createLogger, createExpressLogger} from '@natlibfi/melinda-commons';
import {AlephStrategy} from '@natlibfi/passport-melinda-aleph';
import {logError} from '@natlibfi/melinda-rest-api-commons';
import {createApiDocRouter, createBulkRouter, createLogsRouter, createPrioRouter} from './routes/index.js';
import ipRangeCheck from 'ip-range-check';

/**
 * @param {{
 *   httpPort: number,
 *   enableProxy: boolean,
 *   xServiceURL: string,
 *   userLibrary: string,
 *   ownAuthzURL: string,
 *   ownAuthzApiKey: string,
 *   sruUrl: string,
 *   amqpUrl: string,
 *   mongoUri: string,
 *   pollWaitTime: number,
 *   recordType: string,
 *   requireAuthForRead: boolean,
 *   requireKVPForWrite: boolean,
 *   fixTypes: string[],
 *   allowedLibs: string[],
 *   ipWhiteList: string[]
 * }} config
 * @returns {Promise<import('http').Server>}
 */
export default async function ({
  httpPort, enableProxy,
  xServiceURL, userLibrary,
  ownAuthzURL, ownAuthzApiKey,
  sruUrl, amqpUrl, mongoUri,
  pollWaitTime, recordType,
  requireAuthForRead, requireKVPForWrite,
  fixTypes, allowedLibs, ipWhiteList
}) {
  const logger = createLogger();
  const server = await initExpress();

  // Soft shutdown function
  server.on('close', () => {
    logger.info('Initiating soft shutdown of Melinda REST API');
    // Things that need soft shutdown
    // Needs amqp disconnect?
    // Needs mongo disconnect?
  });

  return server;

  async function initExpress() {
    const app = express();

    app.disable('x-powered-by'); // Security
    // @ts-expect-error Express 4's app.enable() only takes one argument, so this extra arg is dead code at runtime (latent bug: trust proxy is always enabled); keeping the call as-is until the behavior question is decided
    app.enable('trust proxy', Boolean(enableProxy));

    app.use(createExpressLogger());

    logger.debug(`xServiceURL: ${xServiceURL}`);

    passport.use(new AlephStrategy({
      xServiceURL, userLibrary,
      ownAuthzURL, ownAuthzApiKey
    }));

    app.use(passport.initialize());
    app.use('/bulk', ipWhiteListMiddleware, passport.authenticate('melinda', {session: false}), await createBulkRouter({mongoUri, amqpUrl, recordType, allowedLibs})); // Must be here to avoid bodyparser
    app.use(bodyParser.text({limit: '5MB', type: '*/*'}));
    app.use('/apidoc', createApiDocRouter());
    app.use('/logs', ipWhiteListMiddleware, passport.authenticate('melinda', {session: false}), await createLogsRouter({mongoUri}));
    app.use('/', ipWhiteListMiddleware, await createPrioRouter({sruUrl, amqpUrl, mongoUri, pollWaitTime, recordType, requireAuthForRead, requireKVPForWrite, fixTypes, allowedLibs}));

    app.use(handleError);

    return app.listen(httpPort, () => logger.info(`Started Melinda REST API for ${recordType} records in port ${httpPort}`));

    /**
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     * @returns {import('express').Response | void}
     */
    function ipWhiteListMiddleware(req, res, next) {
      logger.verbose('Ip whitelist middleware');
      if (ipWhiteList.length === 0) {
        return next();
      }
      const connectionIp = req.headers['cf-connecting-ip'];
      //logger.debug(connectionIp);
      if (ipRangeCheck(`${connectionIp}`, ipWhiteList)) {
        logger.debug('IP ok');
        return next();
      }

      logger.debug(`Bad IP: ${connectionIp}`);
      return res.sendStatus(httpStatus.FORBIDDEN);
    }

    /**
     * @param {any} err
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     * @returns {import('express').Response | void}
     */
    function handleError(err, req, res, next) {
      logger.debug(`App/handleError: Error: ${JSON.stringify(err)}`);
      if (err) {
        logError(err);

        // why does instanceof not work?
        if (err instanceof ApiError) {
          logger.debug('Responding expected');
          return res.status(err.status).send(err.payload);
        }

        if (err.status && err.payload) {
          logger.debug('We have an error with status and payload');
          return res.status(err.status).send(err.payload);
        }

        if (err.status) {
          logger.debug('We have an error with status');
          return res.sendStatus(err.status);
        }

        if (req.aborted) {
          logger.debug('Responding timeout');
          return res.status(httpStatus.REQUEST_TIMEOUT).send(httpStatus['504_MESSAGE']);
        }

        logger.debug('Responding unexpected');
        return res.sendStatus(httpStatus.INTERNAL_SERVER_ERROR);
      }

      next();
    }
  }
}
