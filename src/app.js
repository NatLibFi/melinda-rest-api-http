import bodyParser from 'body-parser';
import express from 'express';
import httpStatus from 'http-status';
import passport from 'passport';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {createLogger, createExpressLogger} from '@natlibfi/melinda-backend-commons';
import AlephStrategy from '@natlibfi/passport-melinda-aleph';
import {logError} from '@natlibfi/melinda-rest-api-commons';
import {createApiDocRouter, createBulkRouter, createPrioRouter} from './routes';

export default async function ({
  httpPort, enableProxy,
  xServiceURL, userLibrary,
  ownAuthzURL, ownAuthzApiKey,
  sruUrl, amqpUrl, mongoUri,
  pollWaitTime
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
    app.enable('trust proxy', Boolean(enableProxy));

    app.use(createExpressLogger());

    passport.use(new AlephStrategy({
      xServiceURL, userLibrary,
      ownAuthzURL, ownAuthzApiKey
    }));

    app.use(passport.initialize());
    app.use('/bulk', await createBulkRouter({mongoUri, amqpUrl})); // Must be here to avoid bodyparser
    app.use(bodyParser.text({limit: '5MB', type: '*/*'}));
    app.use('/apidoc', createApiDocRouter());
    app.use('/', await createPrioRouter({sruUrl, amqpUrl, mongoUri, pollWaitTime}));
    app.use(handleError);

    return app.listen(httpPort, () => logger.info(`Started Melinda REST API in port ${httpPort}`));

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
