import {handleInterrupt} from '@natlibfi/melinda-commons';
import * as config from './config.js';
import startApp from './app.js';
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

    /** @param {NodeJS.Signals} signal */
    function handleSignal(signal) {
      handleTermination({code: 1, message: `Received ${signal}`});
    }
  }

  /**
   * @param {{code?: number, message?: string | boolean}} params
   */
  function handleTermination({code = 0, message = false}) {
    logMessage(message);

    process.exit(code);

    /** @param {string | boolean} message */
    function logMessage(message) {
      if (message) {
        return logError(message);
      }
    }
  }
}
