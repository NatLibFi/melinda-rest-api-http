import moment from 'moment';
import sanitize from 'mongo-sanitize';
import {createLogger} from '@natlibfi/melinda-commons';
import {parseBoolean} from '@natlibfi/melinda-commons';

const logger = createLogger();

// Query filters
// skip int 0-999999 skips from results
// limit int 0-999999 limits response amount
// id uuid v4 correlationId
// queueItemState string enum QUEUE_ITEM_STATE
// creationTime stringified array of utc timestamps 1 specific or 2 for range
// modificationTime stringified array of utc timestamps 1 specific or 2 for range

export interface GenerateQueryParams {
  id?: string;
  correlationId?: string;
  queueItemState?: string;
  creationTime?: string;
  modificationTime?: string;
  skip?: string | number;
  limit?: string | number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the generated Mongo query document is dynamic; the tests deepEqual it via raw property access
export function generateQuery({id, correlationId, queueItemState, creationTime, modificationTime, skip, limit}: GenerateQueryParams): any {
  logger.silly(`generateQuery`);
  const doc: Record<string, unknown> = {};

  if (skip) {
    doc['skip'] = skip;
  }

  if (limit) {
    doc['limit'] = limit;
  }

  // We parse both 'id' and 'correlationId' in query as correlationId in Mongo

  if (id) {
    doc['correlationId'] = sanitize(id);
  }

  if (correlationId) {
    doc['correlationId'] = sanitize(correlationId);
  }

  // we could have here also final: ABORT, DONE, ERROR, active: !final
  if (queueItemState) {
    doc['queueItemState'] = queueItemState;
  }

  if (creationTime) {
    const timestampArray = JSON.parse(creationTime);
    if (creationTime.length === 1) {
      doc['creationTime'] = formatTime(timestampArray[0]);
    } else {
      doc['$and'] = [
        {creationTime: {$gte: formatTime(timestampArray[0])}},
        {creationTime: {$lte: formatTime(timestampArray[1])}}
      ];
    }
  }

  if (modificationTime) {
    const timestampArray = JSON.parse(modificationTime);
    if (modificationTime.length === 1) {
      doc['modificationTime'] = formatTime(timestampArray[0]);
    } else {
      doc['$and'] = [
        {modificationTime: {$gte: formatTime(timestampArray[0])}},
        {modificationTime: {$lte: formatTime(timestampArray[1])}}
      ];
    }
  }

  return doc;

  function formatTime(timestamp: string) {
    logger.debug(`Timestamp: ${timestamp}`);
    // Ditch the timezone
    const time = moment.utc(timestamp);
    logger.silly(time);
    return time.toDate();
  }
}

export interface GenerateShowParamsInput {
  showAll?: string | number;
  showOperations?: string;
  showOperationSettings?: string;
  showRecordLoadParams?: string;
  showImportJobState?: string;
}

export function generateShowParams({showAll = 0, showOperations = undefined, showOperationSettings = undefined, showRecordLoadParams = undefined, showImportJobState = undefined}: GenerateShowParamsInput): Record<string, boolean> {
  if (parseBoolean(showAll as string)) {
    return {showAll: true};
  }

  const paramsArray = [
    {showAll: showAll ? parseBoolean(showAll as string) : false},
    {showOperations: showOperations ? parseBoolean(showOperations) : false},
    {showOperationSettings: showOperationSettings ? parseBoolean(showOperationSettings) : false},
    {showRecordLoadParams: showRecordLoadParams ? parseBoolean(showRecordLoadParams) : false},
    {showImportJobState: showImportJobState ? parseBoolean(showImportJobState) : false}
  ].filter(param => param);

  // @ts-expect-error non-tuple array spread is rejected by tsc though the call is valid at runtime
  return Object.assign(...paramsArray);
}


/*
export function generateShowParams({showAll = 0, showOperations = 0, showOperationSettings = 0, showRecordLoadParams = 0, showImportJobState = 0}) {
  if (parseBoolean(showAll)) {
    return {showOperations: 1, showOperationSettings: 1, showRecordLoadParams: 1, showImportJobState: 1};
  }

  return {showOperations, showOperationSettings, showRecordLoadParams, showImportJobState};
}
*/
