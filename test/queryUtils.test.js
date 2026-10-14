import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {checkQueryParams} from '../src/routes/queryUtils.js';

const UUID_V4 = '123e4567-e89b-42d3-a456-426614174000';
const UUID_V4_OTHER = '223e4567-e89b-42d3-a456-426614174000';
const VALID_TIMESTAMP = '2026-01-01T12:34:56.789Z';

// Plain mock middleware plumbing: records what the middleware does to res
// and whether next() was called.
function run(query = {}) {
  const req = {query};
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
    }
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };
  checkQueryParams(req, res, next);
  return {nextCalled, res};
}

function assertBadRequest(result, failedParams, nonCompatibleParams = []) {
  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 400);
  assert.deepEqual(result.res.body, {
    error: 'BAD query params',
    failedParams,
    nonCompatibleParams
  });
}

describe('checkQueryParams: valid params', () => {
  it('empty query passes and calls next without touching res', () => {
    const {nextCalled, res} = run({});
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
    assert.equal(res.body, null);
  });

  it('accepts every param at a valid value', () => {
    const {nextCalled, res} = run({
      id: UUID_V4,
      correlationId: UUID_V4,
      pOldNew: 'NEW',
      pActiveLibrary: 'FIN01',
      noStream: 'true',
      noop: 'false',
      unique: '1',
      merge: '0',
      validate: 'true',
      skipLowValidation: 'false',
      failOnError: '1',
      skipNoChangeUpdates: '0',
      matchFailuresAsNew: 'true',
      pRejectFile: 'a/b_reject.txt',
      pLogFile: 'log-file.txt',
      pCatalogerIn: 'ABC-123',
      creationTime: JSON.stringify([VALID_TIMESTAMP]),
      modificationTime: JSON.stringify(['2026-01-01']),
      queueItemState: 'DONE',
      fixType: 'DELET',
      logItemType: 'MATCH_LOG',
      blobSequence: '12',
      standardIdentifiers: 'abc-def_1',
      databaseId: '123456789',
      sourceIds: '(12345)ABC',
      force: 'true',
      expanded: 'false',
      catalogers: 'A1,B2',
      logItemTypes: 'MATCH_LOG,MERGE_LOG',
      skip: '100',
      limit: '10',
      showAll: 'false',
      showOperations: 'true',
      showOperationSettings: '1',
      showRecordLoadParams: '0',
      showImportJobState: 'true',
      recordsAsReport: 'true',
      noRecords: 'false',
      noIds: '1'
    });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
  });

  it('accepts id and correlationId with the same value', () => {
    const {nextCalled} = run({id: UUID_V4, correlationId: UUID_V4});
    assert.equal(nextCalled, true);
  });

  it('accepts date-only timestamps in creationTime/modificationTime', () => {
    const {nextCalled} = run({
      creationTime: '["2026-01-01"]',
      modificationTime: '["2026-01-01", "2026-02-01"]'
    });
    assert.equal(nextCalled, true);
  });
});

describe('checkQueryParams: invalid individual params', () => {
  it('rejects an id that is not a uuid v4', () => {
    assertBadRequest(run({id: 'not-a-uuid'}), ['id']);
  });

  it('rejects a correlationId that is not a uuid v4', () => {
    assertBadRequest(run({correlationId: 'not-a-uuid'}), ['correlationId']);
  });

  it('rejects pOldNew other than NEW/OLD', () => {
    assertBadRequest(run({pOldNew: 'BOTH'}), ['pOldNew']);
  });

  it('rejects pActiveLibrary that does not match FIN\\d\\d', () => {
    assertBadRequest(run({pActiveLibrary: 'FIN1'}), ['pActiveLibrary']);
  });

  it('rejects boolean-ish params with non-boolean values', () => {
    for (const name of [
      'noStream',
      'noop',
      'unique',
      'merge',
      'validate',
      'skipLowValidation',
      'failOnError',
      'skipNoChangeUpdates',
      'matchFailuresAsNew',
      'force',
      'expanded',
      'showAll',
      'showOperations',
      'showOperationSettings',
      'showRecordLoadParams',
      'showImportJobState',
      'recordsAsReport',
      'noRecords',
      'noIds'
    ]) {
      const result = run({[name]: 'maybe'});
      // NOTE: the failedParams entry for matchFailuresAsNew is reported
      // under the misspelled key "maatchFailuresAsNew" in the source
      // (suspected bug, asserted as actual behavior).
      const expectedName = name === 'matchFailuresAsNew' ? 'maatchFailuresAsNew' : name;
      assertBadRequest(result, [expectedName]);
    }
  });

  it('rejects pRejectFile with characters outside [A-Za-z0-9/._-]', () => {
    assertBadRequest(run({pRejectFile: 'a b.txt'}), ['pRejectFile']);
  });

  it('rejects pLogFile with characters outside [A-Za-z0-9/._-]', () => {
    assertBadRequest(run({pLogFile: 'a b.txt'}), ['pLogFile']);
  });

  it('rejects pCatalogerIn with lowercase letters (case-sensitive regex)', () => {
    assertBadRequest(run({pCatalogerIn: 'abc'}), ['pCatalogerIn']);
  });

  it('rejects fixType with lowercase letters (case-sensitive regex)', () => {
    assertBadRequest(run({fixType: 'delet'}), ['fixType']);
  });

  it('rejects creationTime that is not a bracketed array', () => {
    assertBadRequest(run({creationTime: '2026-01-01T12:34:56.789Z'}), ['creationTime']);
  });

  it('rejects creationTime whose timestamps do not match the formats', () => {
    assertBadRequest(run({creationTime: '["2026-99-99"]'}), ['creationTime']);
  });

  it('rejects modificationTime whose timestamps do not match the formats', () => {
    assertBadRequest(run({modificationTime: '["nope"]'}), ['modificationTime']);
  });

  it('rejects queueItemState outside the known states', () => {
    assertBadRequest(run({queueItemState: 'NOPE'}), ['queueItemState']);
  });

  it('rejects logItemType outside LOG_ITEM_TYPE', () => {
    assertBadRequest(run({logItemType: 'NOPE'}), ['logItemType']);
  });

  it('rejects logItemTypes when any comma-separated entry is unknown', () => {
    assertBadRequest(run({logItemTypes: 'MATCH_LOG,NOPE'}), ['logItemTypes']);
  });

  it('rejects blobSequence with non-digits', () => {
    assertBadRequest(run({blobSequence: '12a'}), ['blobSequence']);
  });

  it('rejects standardIdentifiers with characters outside the allowed set', () => {
    assertBadRequest(run({standardIdentifiers: 'a$b'}), ['standardIdentifiers']);
  });

  it('rejects databaseId unless it is exactly 9 digits', () => {
    assertBadRequest(run({databaseId: '123'}), ['databaseId']);
  });

  it('rejects sourceIds that do not match (XXXXX)YYZ shape', () => {
    assertBadRequest(run({sourceIds: '123'}), ['sourceIds']);
  });

  it('rejects catalogers with an empty entry', () => {
    assertBadRequest(run({catalogers: 'A1,,'}), ['catalogers']);
  });

  it('rejects skip/limit unless 1-7 digits', () => {
    assertBadRequest(run({skip: 'abc'}), ['skip']);
    assertBadRequest(run({skip: '12345678'}), ['skip']);
    assertBadRequest(run({limit: '1e5'}), ['limit']);
  });
});

describe('checkQueryParams: non-compatible param combinations', () => {
  it('rejects id and correlationId that differ (both must be valid uuids)', () => {
    const result = run({id: UUID_V4, correlationId: UUID_V4_OTHER});
    assertBadRequest(result, [], ['correlationId', 'id']);
  });
});
