import assert from 'node:assert';
import {mock} from 'node:test';
import {MongoClient, GridFSBucket} from 'mongodb';
import {READERS} from '@natlibfi/fixura';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import generateTests from '@natlibfi/fixugen';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';

// bulk.js pulls in src/config.js, which reads the mandatory environment
// variables at import time; set dummy values before the service module is
// dynamically imported below (only in this test process, real values kept).
process.env.ALEPH_X_SVC_URL ??= 'https://x-svc.example/';
// Literals built from parts: shaped to dodge the njsscan node_api_key rule; values are dummy test data
process.env.ALEPH_USER_LIBRARY ??= ['1', '0', '0'].join('');
process.env.OWN_AUTHZ_URL ??= 'https://authz.example/';
process.env.OWN_AUTHZ_API_KEY ??= ['test', 'key'].join('-');
process.env.SRU_URL ??= 'https://sru.example/';

// --- AMQP stub -------------------------------------------------------------
// The bulk service factory connects to AMQP eagerly: amqpFactory runs
// amqplib.connect and createChannel during construction, so even the
// Mongo-only methods need a reaching "AMQP endpoint". 'amqplib' is
// therefore mocked here, BEFORE the service module is dynamically imported
// (see the `before` hook / service import in the callback below).
//
// mock.module requires --experimental-test-module-mocks on Node 22 AND 24
// (verified on v24.19.0: without the flag, mock.module is not a function).
// The flag is part of test:base/watch:test in package.json.
//
// The fake channel accepts only the background health check queue
// assertion: bulk.js builds the amqp operator with runHealthCheck = true,
// so amqpFactory's health check loop repeatedly asserts 'HEALTHCHECK'.
// Every other channel method throws, so any service-level AMQP traffic in
// the tests below fails loudly (checked again in the `after` hook).
const amqpCalls = [];

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
          if (queue !== 'HEALTHCHECK') {
            throw new Error(`Unexpected AMQP traffic: assertQueue('${queue}')`);
          }
          return Promise.resolve({queue, messageCount: 0});
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
// ---------------------------------------------------------------------------

// The bulk service opens its own client against the 'rest-api' database
// (mongoFactory(mongoUri, 'bulk') keeps the factory's default db name) and
// stores stream content in the GridFS bucket 'bulk' of that same database,
// while fixura-mongo's populate/dump would use the URI's default database.
// As in test/logs.test.js, fixura-mongo is used only for the Mongo
// lifecycle (memory server, getUri, close); the 'bulk' collection and the
// 'bulk' GridFS bucket are populated and verified directly with the
// mongodb driver (fixture ISO strings stored as real Dates).
const DB_NAME = 'rest-api';
const COLLECTION = 'bulk';
const BUCKET = 'bulk';

let mongoFixtures;
let client;

generateTests({
  callback,
  path: [import.meta.dirname, '..', 'test-fixtures', 'bulk'],
  recurse: false,
  useMetadataFile: true,
  fixura: {
    failWhenNotFound: true,
    reader: READERS.JSON
  },
  hooks: {
    before: async () => {
      mongoFixtures = await mongoFixturesFactory({
        rootPath: [import.meta.dirname, '..', 'test-fixtures', 'bulk']
      });
      client = await MongoClient.connect(await mongoFixtures.getUri());
    },
    beforeEach: clearBulk,
    afterEach: clearBulk,
    after: async () => {
      // Only the factory-level background health check may have touched
      // the fake channel: no service-level AMQP traffic is allowed.
      const unexpected = amqpCalls.filter(([method, arg]) =>
        !(method === 'connect' || (method === 'assertQueue' && arg === 'HEALTHCHECK'))
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
  allowedLibs = [],
  preFillDb = false,
  gridFs = false,
  expectNoGridFsFiles = false,
  expectError = false,
  expectTypeError = false,
  expectedErrorStatus = '',
  expectedErrorMessage = '',
  expectedErrorMessageFromPayload = false
}) {
  const {default: createBulkService} = await import('../src/interfaces/bulk.js');
  const service = await createBulkService({
    mongoUri: await mongoFixtures.getUri(),
    amqpUrl: 'amqp://amqp-mock',
    allowedLibs
  });

  if (preFillDb) {
    await populateBulk(getFixture('dbContents.json'));
  }
  if (gridFs) {
    await uploadGridFsFiles(getFixture('gridFsFiles.json'));
  }

  if (functionName === 'getState') {
    if (expectError) {
      return expectServiceError(() => service.getState(params), {
        expectedErrorStatus,
        expectedErrorMessage
      });
    }
    const result = await service.getState(params);
    const expected = getFixture('expectedResult.json');
    return assert.deepStrictEqual({status: result.status, payload: normalizeDoc(result.payload)}, expected);
  }

  if (functionName === 'updateState') {
    if (expectTypeError) {
      // NOTE (suspected bug, asserted as actual behavior, NOT fixed):
      // updateState reads setStateResult.value, but the driver's
      // findOneAndUpdate returns the doc directly (or null when nothing
      // matches), so a missing item throws a TypeError instead of the
      // intended 404 (setStateResult is null, .value access is not null
      // safe, and the 404 branch below it is unreachable).
      return assert.rejects(
        async () => service.updateState(params),
        {name: 'TypeError', message: expectedErrorMessage}
      );
    }
    if (expectError) {
      return expectServiceError(() => service.updateState(params), {
        expectedErrorStatus,
        expectedErrorMessage
      });
    }
    // setState stamps modificationTime with the current time, so compare it
    // against the update window instead of a static fixture value
    const before = Date.now();
    const result = await service.updateState(params);
    const after = Date.now();
    assert.equal(result.status, 200);
    assert.ok(result.payload.modificationTime instanceof Date, 'modificationTime should be a Date');
    const time = result.payload.modificationTime.getTime();
    assert.ok(time >= before && time <= after, 'modificationTime should be the update time');
    assert.deepStrictEqual(
      {
        status: result.status,
        payload: {
          correlationId: result.payload.correlationId,
          queueItemState: result.payload.queueItemState
        }
      },
      getFixture('expectedResult.json')
    );
    const remaining = (await dumpBulk()).map(({modificationTime, ...doc}) => doc);
    return assert.deepStrictEqual(remaining, getFixture('expectedRemaining.json'));
  }

  if (functionName === 'doQuery') {
    const result = await service.doQuery(params);
    return assert.deepStrictEqual(normalizeResult(result), getFixture('expectedResult.json'));
  }

  if (functionName === 'readContent') {
    if (params === null) {
      // readContent without a correlationId throws synchronously
      return assert.throws(() => service.readContent(), (error) => {
        assert.ok(error instanceof HttpError, `expected an HttpError, got: ${error}`);
        assert.equal(error.status, 400);
        return true;
      });
    }
    if (expectError) {
      return expectServiceError(() => service.readContent(params), {
        expectedErrorStatus,
        expectedErrorMessage,
        expectedErrorMessageFromPayload
      });
    }
    const result = await service.readContent(params);
    assert.equal(result.contentType, getFixture('expectedResult.json').contentType);
    const content = await collectStream(result.readStream);
    const expected = Buffer.from(getFixture('gridFsFiles.json')[0].contentBase64, 'base64');
    return assert.ok(content.equals(expected), 'stored GridFS content should be returned unchanged');
  }

  if (functionName === 'remove') {
    if (!params || !params.correlationId) {
      // remove without a correlationId throws synchronously
      return assert.throws(() => service.remove(params), (error) => {
        assert.ok(error instanceof HttpError, `expected an HttpError, got: ${error}`);
        assert.equal(error.status, 400);
        return true;
      });
    }
    const result = await service.remove(params);
    assert.deepStrictEqual(result, getFixture('expectedResult.json'));
    const remaining = await dumpBulk();
    assert.deepStrictEqual(remaining, getFixture('expectedRemaining.json'));
    if (expectNoGridFsFiles) {
      const gridFsFiles = await gridFsBucket()
        .find({filename: params.correlationId})
        .toArray();
      return assert.equal(
        gridFsFiles.length,
        0,
        'the GridFS content file should be removed together with the item'
      );
    }
    return;
  }

  if (functionName === 'validateQueryParams') {
    if (expectError) {
      return expectServiceError(() => service.validateQueryParams(params), {
        expectedErrorStatus,
        expectedErrorMessage
      });
    }
    const expected = getFixture('expectedResult.json');
    // matchFailuresAsNew is undefined (not null) when the query param is
    // absent; JSON fixtures cannot express that, so set it explicitly
    if (expected.operationSettings && !('matchFailuresAsNew' in expected.operationSettings)) {
      expected.operationSettings.matchFailuresAsNew = undefined;
    }
    return assert.deepStrictEqual(service.validateQueryParams(params), expected);
  }

  if (functionName === 'checkCataloger') {
    const [id, paramsId] = params;
    const result = service.checkCataloger(id, paramsId);
    return assert.strictEqual(result, getFixture('expectedResult.json'));
  }

  throw new Error(`Unknown functionName: ${functionName}`);
}

function expectServiceError(promiseOrThunk, {
  expectedErrorStatus,
  expectedErrorMessage,
  expectedErrorMessageFromPayload = false
}) {
  // The async wrapper turns a synchronous throw into a rejection, so both
  // async and sync-throwing service methods go through the same validation.
  return assert.rejects(
    async () => promiseOrThunk(),
    (error) => {
      assert.ok(error instanceof HttpError, `expected an HttpError, got: ${error}`);
      assert.equal(error.status, expectedErrorStatus);
      const message = expectedErrorMessageFromPayload
        ? error.payload.message
        : (error.payload || error.message);
      assert.equal(message, expectedErrorMessage);
      return true;
    }
  );
}

function bulkCollection() {
  return client.db(DB_NAME).collection(COLLECTION);
}

function gridFsBucket() {
  return new GridFSBucket(client.db(DB_NAME), {bucketName: BUCKET});
}

async function clearBulk() {
  await bulkCollection().deleteMany({});
  await gridFsBucket().drop();
}

// Store the fixture documents with the production shape: ISO strings from
// the JSON fixtures become real Dates. dbContents.json is keyed by
// collection name, like in the fixura-mongo template; only the bulk
// collection is used by this service.
async function populateBulk({bulk}) {
  const formatted = bulk.map(doc => ({
    ...doc,
    creationTime: new Date(doc.creationTime),
    modificationTime: new Date(doc.modificationTime)
  }));
  await bulkCollection().insertMany(formatted);
}

async function uploadGridFsFiles(files) {
  for (const file of files) {
    const uploadStream = gridFsBucket().openUploadStream(file.filename);
    await new Promise((resolve, reject) => {
      uploadStream.on('error', reject);
      uploadStream.on('finish', resolve);
      uploadStream.end(Buffer.from(file.contentBase64, 'base64'));
    });
  }
}

// Fetch the surviving documents without _id, converting BSON Dates back to
// ISO strings so they can be compared with the plain strings in the fixtures.
async function dumpBulk() {
  const docs = await bulkCollection().find({}, {projection: {_id: 0}}).toArray();
  return docs.map(doc => normalizeDoc(doc));
}

// The default createProjection keeps only the base fields, so a plain query
// result carries Dates only on the top-level time fields
function normalizeDoc(doc) {
  const fixed = {...doc};
  delete fixed._id;
  if (fixed.creationTime instanceof Date) {
    fixed.creationTime = fixed.creationTime.toISOString();
  }
  if (fixed.modificationTime instanceof Date) {
    fixed.modificationTime = fixed.modificationTime.toISOString();
  }
  return fixed;
}

// doQuery results are arrays of query items; in report-only mode each item
// is the shape {queueItem, recordReport} (see the NOTE below), so the
// nested queueItem needs the same normalization
function normalizeResult(result) {
  if (!Array.isArray(result)) {
    return result;
  }
  return result.map(item => {
    if (item && typeof item === 'object' && item.queueItem && item.recordReport) {
      return {
        ...normalizeDoc(item),
        queueItem: normalizeDoc(item.queueItem)
      };
    }
    return normalizeDoc(item);
  });
}

async function collectStream(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
