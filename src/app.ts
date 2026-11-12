import bodyParser from 'body-parser';
import express from 'express';
import httpStatus from 'http-status';
import passport from 'passport';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {createLogger, createExpressLogger} from '@natlibfi/melinda-commons';
import {AlephStrategy} from '@natlibfi/passport-melinda-aleph';
import {logError} from '@natlibfi/melinda-rest-api-commons';
import {createApiDocRouter, createBulkRouter, createLogsRouter, createPrioRouter} from './routes/index.ts';
import ipRangeCheck from 'ip-range-check';
import type {NextFunction, Request, Response} from 'express';
import type {Server} from 'node:http';

export default async function ({
  httpPort, enableProxy,
  xServiceURL, userLibrary,
  ownAuthzURL, ownAuthzApiKey,
  sruUrl, amqpUrl, mongoUri,
  pollWaitTime, recordType,
  requireAuthForRead, requireKVPForWrite,
  fixTypes, allowedLibs, ipWhiteList
}: {
  httpPort: number,
  enableProxy: boolean,
  xServiceURL: string,
  userLibrary: string,
  ownAuthzURL: string,
  ownAuthzApiKey: string,
  sruUrl: string,
  amqpUrl: string,
  mongoUri: string,
  pollWaitTime: number,
  recordType: string,
  requireAuthForRead: boolean,
  requireKVPForWrite: boolean,
  fixTypes: string[],
  allowedLibs: string[],
  ipWhiteList: string[]
}): Promise<Server> {
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

    // Express 5 changed the default query parser from 'extended' (qs) to 'simple';
    // pin 'extended' to keep the Express 4 query behavior (bracketed keys nested,
    // repeated keys as arrays, bracketed JSON-array strings passed through as-is)
    app.set('query parser', 'extended');

    app.disable('x-powered-by'); // Security
    // @ts-expect-error app.enable() only takes one argument, so this extra arg is dead code at runtime (latent bug: trust proxy is always enabled); keeping the call as-is until the behavior question is decided
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

    return app.listen(httpPort, (error: Error | undefined) => {
      // Express' app.listen is a raw pass-through to Node's server.listen:
      // on a bind failure (e.g. EADDRINUSE) this same callback is invoked
      // with the error as its first argument. Without this check the
      // success message would be logged and the process would sit alive
      // (mongo/amqp clients keep the event loop busy) while serving nothing.
      if (error) {
        logger.error(`Failed to start HTTP server on port ${httpPort}: ${error.message}`);
        return process.exit(1);
      }
      logger.info(`Started Melinda REST API for ${recordType} records in port ${httpPort}`);
    });

    function ipWhiteListMiddleware(req: Request, res: Response, next: NextFunction) {
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

    function handleError(err: unknown, req: Request, res: Response, next: NextFunction): Response | void {
      logger.debug(`App/handleError: Error: ${JSON.stringify(err)}`);
      if (err) {
        logError(err);

        // why does instanceof not work?
        if (err instanceof ApiError) {
          logger.debug('Responding expected');
          return res.status(err.status).send(err.payload);
        }

        const {status, payload} = err as {status?: number, payload?: unknown};
        if (status && payload) {
          logger.debug('We have an error with status and payload');
          return res.status(status).send(payload);
        }

        if (status) {
          logger.debug('We have an error with status');
          return res.sendStatus(status);
        }

        // Express 5 removed req.aborted (which tracked the socket); the modern equivalent is
        // req.socket.destroyed. Note: req.destroyed is NOT equivalent - it is the request
        // stream state, which is true once the request body has been consumed, even when
        // the client is still connected.
        if (req.socket.destroyed) {
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
