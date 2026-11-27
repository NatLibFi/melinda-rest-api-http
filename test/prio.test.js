import assert from 'node:assert';
import {EventEmitter} from 'node:events';
import {mock} from 'node:test';
import {MongoClient} from 'mongodb';
import {READERS} from '@natlibfi/fixura';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import generateTests from '@natlibfi/fixugen';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';

// Set dummy values for the environment variables the src/ modules read at
// import time, BEFORE the service module is dynamically imported below
// (only in this test process, real values kept).
process.env.ALEPH_X_SVC_URL ??= 'https://x-svc.example/';
// Literals built from parts: shaped to dodge the njsscan node_api_key rule; values are dummy test data
process.env.ALEPH_USER_LIBRARY ??= ['1', '0', '0'].join('');
process.env.OWN_AUTHZ_URL ??= 'https://authz.example/';
process.env.OWN_AUTHZ_API_KEY ??= ['test', 'key'].join('-');
process.env.SRU_URL ??= 'https://sru.example/';

// --- AMQP stub with recorded publishes + poll-loop control point -----------
// As in test/bulk.test.js and test/bulk-amqp.test.js, 'amqplib' is mocked
// BEFORE the service module is dynamically imported (the mock intercepts the
// import inside the published melinda-rest-api-commons dist, which is what
// actually calls amqplib).
//
// The fake channel is the recording extension of the throw-on-traffic fake:
// besides the background health check queue assertion (the service builds
// the amqp operator with runHealthCheck = true, so the factory's loop
// repeatedly asserts 'HEALTHCHECK') it allows and records the calls the
// real AMQP leg of prio create/update/fix makes:
//   - assertQueue('REQUESTS', {durable: true})
//   - sendToQueue('REQUESTS', content, {correlationId, persistent, headers})
// Every other channel method still throws, so any other service-level AMQP
// traffic fails loudly (checked again in the `after` hook).
//
// The fake sendToQueue is also the poll-loop control point: the case's
// finish.json is applied to the REAL (in-memory) Mongo queueItem, so the
// check() loop sees the target state on the next poll. With the default
// (immediate) finish the mutation lands before the first poll; with
// delayFinish the mutation is scheduled after the send resolves, so the
// first poll sees the non-terminal state and the loop must wait
// (pollWaitTime, 1 ms here) and poll again before it terminates.
//
// Recorded publishes are the {queue, content, correlationId, persistent,
// headers} tuples the fake sendToQueue was called with; content is
// stringified (the real channel receives a Buffer).
const amqpCalls = [];
let publishes = [];
let finishOnPublish = null;
let finishDelayed = false;

function makeFakeChannel() {
  return new Proxy({}, {
    get(_, prop) {
      // 'then' (and symbols) must stay undefined, or wrapping the channel in
      // a Promise (as amqpFactory does) would see a throwing thenable
      if (typeof prop === 'symbol' || prop === 'then') {
        return undefined;
      }
      // amqpFactory stringifies the channel in a debug template literal at
      // construction; stringification is not AMQP traffic
      if (prop === 'toString') {
        return () => 'FakeAmqpChannel';
      }
      if (prop === 'assertQueue') {
        return (queue) => {
          amqpCalls.push(['assertQueue', queue]);
          const isHealthCheck = queue === 'HEALTHCHECK';
          const isPrioRequests = queue === 'REQUESTS';
          if (!isHealthCheck && !isPrioRequests) {
            throw new Error(`Unexpected AMQP traffic: assertQueue('${queue}')`);
          }
          return Promise.resolve({queue, messageCount: 0});
        };
      }
      if (prop === 'sendToQueue') {
        return (queue, content, options) => {
          if (queue !== 'REQUESTS') {
            throw new Error(`Unexpected AMQP traffic: sendToQueue('${queue}')`);
          }
          publishes.push({
            queue,
            content: content.toString(),
            correlationId: options.correlationId,
            persistent: options.persistent,
            headers: options.headers
          });
          // Poll-loop control point: move the real queueItem to the
          // case's target state (finish.json is the $set document)
          if (finishDelayed) {
            // Land the mutation AFTER the first poll, so the loop's
            // wait-and-poll-again branch is exercised
            setTimeout(() => {
              void mutatePrioQueueItem(options.correlationId);
            }, 10);
            return Promise.resolve();
          }
          return mutatePrioQueueItem(options.correlationId);
        };
      }
      return () => {
        throw new Error(`Unexpected AMQP traffic: channel.${prop}() was called`);
      };
    }
  });
}

mock.module('amqplib', {
  exports: {
    default: {
      connect: (url) => {
        amqpCalls.push(['connect', url]);
        return Promise.resolve({
          createChannel: () => Promise.resolve(makeFakeChannel())
        });
      }
    }
  }
});

// The service constructs an SRU client at startup. The create/update/fix
// response data comes from the queueItem itself (no SRU round trip on those
// paths), so the stub only needs to satisfy construction and the
// searchRetrieve call shape.
mock.module('@natlibfi/sru-client', {
  exports: {
    default: () => ({
      searchRetrieve: () => new EventEmitter()
    })
  }
});
// ---------------------------------------------------------------------------

// The service opens its own client against the 'rest-api' database
// (mongoFactory(mongoUri, 'prio') keeps the factory's default db name) and
// stores its queueItems in the 'prio' collection of that database, while
// fixura-mongo's populate/dump would use the URI's default database.
// As in test/bulk-amqp.test.js, fixura-mongo is used only for the Mongo
// lifecycle (memory server, getUri, close); the 'prio' collection is
// mutated (by the fake sendToQueue) and verified directly with the mongodb
// driver.
const DB_NAME = 'rest-api';
const COLLECTION = 'prio';

let mongoFixtures;
let client;

generateTests({
  callback,
  path: [import.meta.dirname, '..', 'test-fixtures', 'prio'],
  recurse: false,
  useMetadataFile: true,
  fixura: {
    failWhenNotFound: true,
    reader: READERS.JSON
  },
  hooks: {
    before: async () => {
      mongoFixtures = await mongoFixturesFactory({
        rootPath: [import.meta.dirname, '..', 'test-fixtures', 'prio']
      });
      client = await MongoClient.connect(await mongoFixtures.getUri());
    },
    beforeEach: async () => {
      await clearPrio();
      publishes = [];
      finishOnPublish = null;
      finishDelayed = false;
    },
    after: async () => {
      // Only the factory-level background health check and the prio
      // REQUESTS queue assertion (made by the commons sendToQueue before
      // each publish) may have touched the fake channel.
      const unexpected = amqpCalls.filter(([method, arg]) =>
        !(
          method === 'connect'
          || (method === 'assertQueue' && (arg === 'HEALTHCHECK' || arg === 'REQUESTS'))
        )
      );
      assert.deepStrictEqual(
        unexpected,
        [],
        `unexpected AMQP traffic: ${JSON.stringify(unexpected)}`
      );
      await client.close();
      await mongoFixtures.close();
    }
  }
});

async function callback({
  getFixture,
  functionName,
  params,
  expectError = false,
  expectedErrorStatus = '',
  expectedErrorMessage = '',
  delayFinish = false,
  expectItemRemoved = false
}) {
  const {default: createPrioService} = await import('../src/interfaces/prio.js');
  finishOnPublish = getFixture('finish.json');
  finishDelayed = delayFinish;
  const service = await createPrioService({
    sruUrl: 'https://sru.example/',
    amqpUrl: 'amqp://amqp-mock',
    mongoUri: await mongoFixtures.getUri(),
    // Smallest accepted value: the loop only sleeps between polls, and no
    // case may depend on real wall-clock waits
    pollWaitTime: 1
  });

  // No per-case reset of the fake's flags after the call: the case
  // functions are awaited promises, so a finally in the caller would run
  // BEFORE the async case body finishes. beforeEach resets all the fake
  // state instead (a leaked flag can only affect the failed case that set
  // it, since resets happen before every case).
  const outcome = expectError
    ? expectServiceError(() => service[functionName](params), {
      getFixture,
      expectedErrorStatus,
      expectedErrorMessage
    })
    : (async () => {
      const result = await service[functionName](params);
      assert.deepStrictEqual(result, getFixture('expectedResult.json'));
    })();

  return outcome.then(async () => {
    // The real AMQP leg: assert the full recorded publish shape
    assert.deepStrictEqual(publishes, getFixture('expectedPublishes.json'));
    return assertQueueItemRemoval(expectItemRemoved);
  });
}

function expectServiceError(call, {
  getFixture,
  expectedErrorStatus,
  expectedErrorMessage
}) {
  return assert.rejects(
    async () => call(),
    (error) => {
      assert.ok(error instanceof HttpError, `expected an HttpError, got: ${error}`);
      assert.equal(error.status, expectedErrorStatus);
      const finish = getFixture('finish.json');
      // The payload follows the response builders: the first recordResponse
      // when the queueItem carries one, otherwise {message, status}; the
      // abort path throws the timeout message string instead
      const expectedPayload = finish.records?.length > 0
        ? finish.records[0]
        : (expectedErrorMessage
          ? expectedErrorMessage
          : {message: finish.errorMessage, status: expectedErrorStatus});
      assert.deepStrictEqual(error.payload, expectedPayload);
      return true;
    }
  );
}

function prioCollection() {
  return client.db(DB_NAME).collection(COLLECTION);
}

async function clearPrio() {
  await prioCollection().deleteMany({});
}

// The fake sendToQueue applies the case's finish.json as a $set update to
// the real queueItem. queryById with checkModTime is a plain findOne by
// correlationId (no modTime filter), so the update is visible to the next
// poll as-is; the document was just created, so its modificationTime is
// fresh and the 1-minute timeout check cannot ABORT it in between.
async function mutatePrioQueueItem(correlationId) {
  await prioCollection().updateOne({correlationId}, {$set: finishOnPublish});
}

async function assertQueueItemRemoval(expectItemRemoved) {
  if (expectItemRemoved) {
    // unawaited-cleanup defect, pinned here: create/update/fix fire the
    // cleanup without awaiting it, so the response resolves BEFORE the
    // removal has landed. Poll the collection (with a deadline) until the
    // effect is observable. Pinned, not fixed.
    await waitForQueueItemCount(0);
    return;
  }
  // Give the unawaited cleanup a chance to run: it must NOT remove the
  // item in these states (only DONE and ERROR+409 are removed)
  await new Promise(resolve => setTimeout(resolve, 150));
  return assertQueueItemCount(1);
}

async function waitForQueueItemCount(count, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const items = await prioCollection().countDocuments({});
    if (items === count) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`prio collection should have ${count} item(s), has ${items}`);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function assertQueueItemCount(count) {
  const items = await prioCollection().countDocuments({});
  assert.equal(items, count, `prio collection should have ${count} item(s), has ${items}`);
}
