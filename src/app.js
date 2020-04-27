import bodyParser from 'body-parser';
import express from 'express';
import HttpStatus from 'http-status';
import passport from 'passport';
import {Error as ApiError, Authentication, Utils} from '@natlibfi/melinda-commons';
import {createApiDocRouter, createBulkRouter, createPrioRouter} from './routes';

export default async function ({
  httpPort, enableProxy,
  xServiceURL, userLibrary,
  ownAuthzURL, ownAuthzApiKey,
  sruBibUrl, amqpUrl, mongoUri,
  pollWaitTime
}, exitCallback) {
  const {createLogger, createExpressLogger} = Utils;
  const logger = createLogger();
  const server = await initExpress();

  // Soft shutdown function
  server.on('close', () => {
    logger.log('info', 'Initiating soft shutdown of Melinda REST API');
    // Things that need soft shutdown
    // Needs amqp disconnect?
    // Needs mongo disconnect?
  });

  return server;

  async function initExpress() {
    const app = express();

    app.enable('trust proxy', Boolean(enableProxy));

    app.use(createExpressLogger());

    passport.use(new Authentication.Aleph.AlephStrategy({
      xServiceURL, userLibrary,
      ownAuthzURL, ownAuthzApiKey
    }));

    app.use(passport.initialize());
    app.use('/bulk', await createBulkRouter(mongoUri)); // Must be here to avoid bodyparser
    app.use(bodyParser.text({limit: '5MB', type: '*/*'}));
    app.use('/apidoc', createApiDocRouter());
    app.use('/', await createPrioRouter({sruBibUrl, amqpUrl, mongoUri, pollWaitTime}));

    app.use(handleError);

    return app.listen(httpPort, () => logger.log('info', `Started Melinda REST API in port ${httpPort}`));

    function handleError(err, req, res) {
      logger.log('info', 'App/handleError');
      if (err instanceof ApiError) {
        logger.log('debug', 'Responding expected');
        res.status(err.status).send(err.payload);
        return;
      }

      if (req.aborted) {
        logger.log('debug', 'Responding timeout');
        res.sendStatus(HttpStatus.REQUEST_TIMEOUT);
        return;
      }

      logger.log('debug', 'Responding unexpected');
      res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
      exitCallback(err.stack);
    }
  }
}
