import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {Error as HttpError} from '@natlibfi/melinda-commons';
import {generateQuery, generateShowParams} from '../src/interfaces/utils.ts';

const VALID_ISO = '2026-01-01T12:34:56.789Z';
const VALID_ISO_END = '2026-02-01T00:00:00.000Z';

describe('generateQuery', () => {
  it('returns an empty object for no input', () => {
    assert.deepEqual(generateQuery({}), {});
  });

  it('passes skip through as-is when truthy', () => {
    assert.deepEqual(generateQuery({skip: '10'}), {skip: '10'});
  });

  it('passes limit through as-is when truthy', () => {
    assert.deepEqual(generateQuery({limit: '5'}), {limit: '5'});
  });

  // The guard is a plain truthiness check, so skip=0 / limit=0 are dropped.
  it('omits falsy skip/limit values (0 is dropped)', () => {
    assert.deepEqual(generateQuery({skip: 0, limit: 0}), {});
  });

  it('maps id to the sanitized correlationId filter', () => {
    assert.deepEqual(generateQuery({id: 'abc-123'}), {correlationId: 'abc-123'});
  });

  it('maps correlationId to the correlationId filter', () => {
    assert.deepEqual(generateQuery({correlationId: 'abc-123'}), {correlationId: 'abc-123'});
  });

  it('correlationId wins when both id and correlationId are given', () => {
    // Both are written to doc.correlationId in order; the second assignment
    // (correlationId) overrides the first (id).
    assert.deepEqual(generateQuery({id: 'FROM_ID', correlationId: 'FROM_CORR'}), {
      correlationId: 'FROM_CORR'
    });
  });

  // NOTE (suspected bug, asserted as actual behavior, NOT fixed here):
  // mongo-sanitize v1 only strips "$"-prefixed keys from objects; plain
  // string values are returned unchanged. sanitize(id) is therefore a no-op
  // for string inputs, so "$"/"." characters in id/correlationId reach the
  // Mongo filter untouched.
  it('leaves $ and . in id/correlationId string values untouched (sanitize is a no-op for strings)', () => {
    assert.deepEqual(generateQuery({id: 'abc.$ne.x'}), {correlationId: 'abc.$ne.x'});
    assert.deepEqual(generateQuery({correlationId: '$where'}), {correlationId: '$where'});
  });

  it('passes queueItemState through as-is', () => {
    assert.deepEqual(generateQuery({queueItemState: 'DONE'}), {queueItemState: 'DONE'});
  });

  it('two-element creationTime JSON array becomes $and with $gte/$lte Date values', () => {
    const query = generateQuery({
      creationTime: JSON.stringify([VALID_ISO, VALID_ISO_END])
    });
    assert.deepEqual(query, {
      $and: [
        {creationTime: {$gte: new Date(VALID_ISO)}},
        {creationTime: {$lte: new Date(VALID_ISO_END)}}
      ]
    });
    assert.ok((query as any).$and[0].creationTime.$gte instanceof Date);
    assert.ok((query as any).$and[1].creationTime.$lte instanceof Date);
  });

  it('two-element modificationTime JSON array becomes $and with $gte/$lte Date values', () => {
    const query = generateQuery({
      modificationTime: JSON.stringify(['2026-01-01', '2026-02-01'])
    });
    assert.deepEqual(query, {
      $and: [
        {modificationTime: {$gte: new Date('2026-01-01T00:00:00.000Z')}},
        {modificationTime: {$lte: new Date('2026-02-01T00:00:00.000Z')}}
      ]
    });
  });

  it('one-element creationTime array is an exact match on creationTime', () => {
    const query = generateQuery({creationTime: JSON.stringify([VALID_ISO])});
    assert.deepEqual(query, {creationTime: new Date(VALID_ISO)});
    assert.ok((query as any).creationTime instanceof Date);
  });

  it('one-element modificationTime array is an exact match on modificationTime', () => {
    const query = generateQuery({modificationTime: JSON.stringify(['2026-01-01'])});
    assert.deepEqual(query, {modificationTime: new Date('2026-01-01T00:00:00.000Z')});
    assert.ok((query as any).modificationTime instanceof Date);
  });

  it('zero-element creationTime array throws BAD_REQUEST', () => {
    assert.throws(
      () => generateQuery({creationTime: JSON.stringify([])}),
      (error: unknown) => {
        assert.ok(error instanceof HttpError, `expected an HttpError, got: ${error}`);
        assert.equal(error.status, 400);
        return true;
      }
    );
  });

  it('zero-element modificationTime array throws BAD_REQUEST', () => {
    assert.throws(
      () => generateQuery({modificationTime: JSON.stringify([])}),
      (error: unknown) => {
        assert.ok(error instanceof HttpError, `expected an HttpError, got: ${error}`);
        assert.equal(error.status, 400);
        return true;
      }
    );
  });

  it('three-element creationTime array of valid timestamps throws BAD_REQUEST', () => {
    assert.throws(
      () => generateQuery({creationTime: JSON.stringify([VALID_ISO, VALID_ISO_END, VALID_ISO_END])}),
      (error: unknown) => {
        assert.ok(error instanceof HttpError, `expected an HttpError, got: ${error}`);
        assert.equal(error.status, 400);
        return true;
      }
    );
  });

  it('three-element modificationTime array of valid timestamps throws BAD_REQUEST', () => {
    assert.throws(
      () => generateQuery({modificationTime: JSON.stringify(['2026-01-01', '2026-02-01', '2026-03-01'])}),
      (error: unknown) => {
        assert.ok(error instanceof HttpError, `expected an HttpError, got: ${error}`);
        assert.equal(error.status, 400);
        return true;
      }
    );
  });

  it('combines several filters into one document', () => {
    const query = generateQuery({
      id: 'abc-123',
      queueItemState: 'ERROR',
      skip: '2',
      limit: '9',
      modificationTime: JSON.stringify(['2026-01-01', '2026-02-01'])
    });
    assert.deepEqual(query, {
      skip: '2',
      limit: '9',
      correlationId: 'abc-123',
      queueItemState: 'ERROR',
      $and: [
        {modificationTime: {$gte: new Date('2026-01-01T00:00:00.000Z')}},
        {modificationTime: {$lte: new Date('2026-02-01T00:00:00.000Z')}}
      ]
    });
  });
});

describe('generateShowParams (active export)', () => {
  // NOTE: the second generateShowParams below the active one in
  // src/interfaces/utils.js is commented-out dead code; removing it is
  // on the phase-2 test backlog and deliberately not done here.

  it('showAll truthy short-circuits to {showAll: true}', () => {
    assert.deepEqual(generateShowParams({showAll: 'true'}), {showAll: true});
    assert.deepEqual(generateShowParams({showAll: '1'}), {showAll: true});
    assert.deepEqual(
      generateShowParams({showAll: 'true', showOperations: 'true'}),
      {showAll: true}
    );
  });

  // NOTE (suspected bug, asserted as actual behavior, NOT fixed here):
  // `.filter(param => param)` can only drop falsy array ENTRIES, but every
  // entry is an object (always truthy), so params with false values are
  // never filtered out: every response carries all five keys. The "collect
  // only the enabled params" intent is not met.
  it('a single show flag on yields all five keys, only the given one true', () => {
    assert.deepEqual(generateShowParams({showOperations: '1'}), {
      showAll: false,
      showOperations: true,
      showOperationSettings: false,
      showRecordLoadParams: false,
      showImportJobState: false
    });
  });

  it('each individual flag can be turned on', () => {
    for (const flag of [
      'showOperations',
      'showOperationSettings',
      'showRecordLoadParams',
      'showImportJobState'
    ]) {
      const result = generateShowParams({[flag]: 'true'});
      assert.equal(result[flag], true, `expected ${flag} to be true`);
    }
  });

  it('all-off case returns all five keys set to false (not an empty object)', () => {
    assert.deepEqual(generateShowParams({}), {
      showAll: false,
      showOperations: false,
      showOperationSettings: false,
      showRecordLoadParams: false,
      showImportJobState: false
    });
  });

  it('explicit false-ish flag values stay false, truthy strings parse to true', () => {
    assert.deepEqual(generateShowParams({showOperations: '0', showImportJobState: 'false'}), {
      showAll: false,
      showOperations: false,
      showOperationSettings: false,
      showRecordLoadParams: false,
      showImportJobState: false
    });
    assert.equal(generateShowParams({showRecordLoadParams: '1'})['showRecordLoadParams'], true);
  });
});
