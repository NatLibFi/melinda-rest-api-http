import bodyParser from 'body-parser';
import express from 'express';
import HttpStatus from 'http-status';
import passport from 'passport';
import {Error, Authentication, Utils} from '@natlibfi/melinda-commons';
import {logError} from '@natlibfi/melinda-rest-api-commons';
import {createApiDocRouter, createBulkRouter, createPrioRouter} from './routes';

export default async function ({
	httpPort, enableProxy,
	xServiceURL, userLibrary,
	ownAuthzURL, ownAuthzApiKey,
	sruBibUrl, amqpUrl, mongoUrl,
	pollWaitTime
}) {
	const {createLogger, createExpressLogger} = Utils;
	const logger = createLogger();
	const server = await initExpress();

	// Soft shutdown function
	server.on('close', async () => {
		// Things that need soft shutdown
		// amqp disconnect?
		// mongo disconnect?
	});

	return server;

	async function initExpress() {
		const app = express();

		if (enableProxy) {
			app.enable('trust proxy', true);
		}

		app.use(createExpressLogger());

		passport.use(new Authentication.Aleph.AlephStrategy({
			xServiceURL, userLibrary,
			ownAuthzURL, ownAuthzApiKey
		}));

		app.use(passport.initialize());
		app.use('/bulk', await createBulkRouter(mongoUrl)); // Must be here to avoid bodyparser
		app.use(bodyParser.text({limit: '5MB', type: '*/*'}));
		app.use('/apidoc', createApiDocRouter());
		app.use('/', await createPrioRouter({sruBibUrl, amqpUrl, pollWaitTime}));

		app.use(handleError);

		return app.listen(httpPort, () => logger.log('info', 'Started Melinda REST API'));

		async function handleError(err, req, res) { // eslint-disable-line no-unused-vars
			// The correct way would be to throw if the error is unexpected...There is a race condition between the request aborted event handler and running async function.
			if (req.aborted) {
				res.sendStatus(HttpStatus.REQUEST_TIMEOUT);
				return;
			}

			if (err instanceof Error) {
				logger.log('debug', 'Responding service');
				res.status(err.status).send(err.payload).end();
				return;
			}

			logger.log('debug', 'Responding internal');
			res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
			logError(err);
		}
	}
}
