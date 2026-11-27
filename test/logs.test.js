import assert from 'node:assert';
import {MongoClient} from 'mongodb';
import {READERS} from '@natlibfi/fixura';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import generateTests from '@natlibfi/fixugen';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import createLogsService from '../src/interfaces/logs.js';

// The logs service opens its own client against the 'rest-api' database
// (mongoLogFactory(mongoUri) keeps the factory's default db name), while
// fixura-mongo's populate/dump operate on the URI's default database. The
// in-memory server still comes from fixura-mongo (getUri/close); the
// 'rest-api' database is populated and verified directly with the mongodb
// driver, mirroring what production addLogItem stores (creationTime as a
// real Date, protected as a boolean).
const DB_NAME = 'rest-api';
const COLLECTION = 'logs';

let mongoFixtures;
let client;

generateTests({
  callback,
  path: [import.meta.dirname, '..', 'test-fixtures', 'logs'],
  recurse: false,
  useMetadataFile: true,
  fixura: {
    failWhenNotFound: true,
    reader: READERS.JSON
  },
  hooks: {
    before: async () => {
      mongoFixtures = await mongoFixturesFactory({
        rootPath: [import.meta.dirname, '..', 'test-fixtures', 'logs']
      });
      client = await MongoClient.connect(await mongoFixtures.getUri());
    },
    beforeEach: () => clearLogs(),
    afterEach: () => clearLogs(),
    after: async () => {
      await client.close();
      await mongoFixtures.close();
    }
  }
});

async function callback({
  getFixture,
  functionName,
  params,
  preFillDb = false,
  expectError = false,
  expectedErrorStatus = '',
  expectedErrorMessage = ''
}) {
  const service = await createLogsService({mongoUri: await mongoFixtures.getUri()});

  if (preFillDb) {
    await populateLogs(getFixture('dbContents.json'));
  }

  if (functionName === 'getLogs') {
    if (expectError) {
      return expectServiceError(() => service.getLogs(params), {expectedErrorStatus, expectedErrorMessage});
    }
    const result = await service.getLogs(params);
    assert.equal(result.status, 200);
    return assert.deepStrictEqual(normalizeDocs(result.payload), getFixture('expectedResult.json'));
  }

  if (functionName === 'doLogsQuery') {
    const result = await service.doLogsQuery(params);
    return assert.deepStrictEqual(normalizeDocs(result), getFixture('expectedResult.json'));
  }

  if (['getListOfCatalogers', 'getListOfCorrelationIds', 'getListOfLogs'].includes(functionName)) {
    // params null means "no argument": the service method's default applies
    // (e.g. getListOfLogs defaults to MERGE_LOG)
    const result = params === null ? await service[functionName]() : await service[functionName](params);
    // distinct() does not guarantee result order, so compare sorted
    return assert.deepStrictEqual([...result].sort(), [...getFixture('expectedResult.json')].sort());
  }

  if (functionName === 'getExpandedListOfLogs') {
    if (expectError) {
      // the invalid logItemType throws synchronously, so hand a thunk over
      return expectServiceError(
        () => service.getExpandedListOfLogs(params),
        {expectedErrorStatus, expectedErrorMessage}
      );
    }
    const result = await service.getExpandedListOfLogs(params);
    // expanded on: aggregate returns docs with creationTime as a BSON Date;
    // expanded off: falls back to the plain distinct list of correlationIds
    const normalized = result.map((doc) => {
      if (doc && typeof doc === 'object' && doc.creationTime instanceof Date) {
        return {...doc, creationTime: doc.creationTime.toISOString()};
      }
      return doc;
    });
    return assert.deepStrictEqual(normalized, getFixture('expectedResult.json'));
  }

  if (functionName === 'protectLog') {
    const [correlationId, blobSequence] = params;
    const result = await service.protectLog(correlationId, blobSequence);
    assert.deepStrictEqual(result, getFixture('expectedResult.json'));
    const remaining = (await dumpLogs()).map(doc => {
      const fixed = {...doc};
      // protect() sets modificationTime to the current time, so it can't be
      // compared against a static fixture
      delete fixed.modificationTime;
      return fixed;
    });
    return assert.deepStrictEqual(remaining, getFixture('expectedRemaining.json'));
  }

  if (functionName === 'removeLog') {
    const [correlationId, force] = params;
    const result = await service.removeLog(correlationId, force);
    assert.deepStrictEqual(result, getFixture('expectedResult.json'));
    return assert.deepStrictEqual(await dumpLogs(), getFixture('expectedRemaining.json'));
  }

  throw new Error(`Unknown functionName: ${functionName}`);
}

function expectServiceError(promiseOrThunk, {expectedErrorStatus, expectedErrorMessage}) {
  // The async wrapper turns a synchronous throw into a rejection, so both
  // async and sync-throwing service methods go through the same validation.
  return assert.rejects(
    async () => promiseOrThunk(),
    (error) => {
      assert.ok(error instanceof HttpError, `expected an HttpError, got: ${error}`);
      assert.equal(error.status, expectedErrorStatus);
      assert.equal(error.payload || error.message, expectedErrorMessage);
      return true;
    }
  );
}

function logsCollection() {
  return client.db(DB_NAME).collection(COLLECTION);
}

async function clearLogs() {
  await logsCollection().deleteMany({});
}

// Store the fixture documents with the production shape: ISO strings from
// the JSON fixtures become real Dates, matching what addLogItem writes.
// dbContents.json is keyed by collection name, like in the fixura-mongo
// template; only the logs collection is used by this service.
async function populateLogs({logs}) {
  const formatted = logs.map(doc => ({
    ...doc,
    creationTime: new Date(doc.creationTime),
    ...(doc.modificationTime ? {modificationTime: new Date(doc.modificationTime)} : {})
  }));
  await logsCollection().insertMany(formatted);
}

// Fetch the surviving documents without _id, converting BSON Dates back to
// ISO strings so they can be compared with the plain strings in the fixtures.
async function dumpLogs() {
  const docs = await logsCollection().find({}, {projection: {_id: 0}}).toArray();
  return normalizeDocs(docs);
}

function normalizeDocs(docs) {
  return docs.map(doc => {
    const fixed = {...doc};
    delete fixed._id;
    if (fixed.creationTime instanceof Date) {
      fixed.creationTime = fixed.creationTime.toISOString();
    }
    if (fixed.modificationTime instanceof Date) {
      fixed.modificationTime = fixed.modificationTime.toISOString();
    }
    return fixed;
  });
}
