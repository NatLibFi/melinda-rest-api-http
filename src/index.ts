import {handleInterrupt} from '@natlibfi/melinda-commons';
import * as config from './config.ts';
import startApp from './app.ts';
import {logError} from '@natlibfi/melinda-rest-api-commons';

run();

async function run() {
  registerInterruptionHandlers();

  await startApp(config);

  function registerInterruptionHandlers() {
    process
      .on('SIGTERM', handleSignal)
      .on('SIGINT', handleInterrupt)
      .on('uncaughtException', ({stack}) => {
        handleTermination({code: 1, message: stack});
      })
      .on('unhandledRejection', ({stack}) => {
        handleTermination({code: 1, message: stack});
      });

    function handleSignal(signal: NodeJS.Signals) {
      handleTermination({code: 1, message: `Received ${signal}`});
    }
  }

  function handleTermination({code = 0, message = false}: {code?: number, message?: string | boolean}) {
    logMessage(message);

    process.exit(code);

    function logMessage(message: string | boolean) {
      if (message) {
        return logError(message);
      }
    }
  }
}
