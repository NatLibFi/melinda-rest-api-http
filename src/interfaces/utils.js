import moment from 'moment';
import sanitize from 'mongo-sanitize';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {parseBoolean} from '@natlibfi/melinda-commons';

const logger = createLogger();

// Query filters
// skip int 0-999999 skips from results
// limit int 0-999999 limits response amount
// id uuid v4 correlationId
// queueItemState string enum QUEUE_ITEM_STATE
// creationTime stringified array of utc timestamps 1 specific or 2 for range
// modificationTime stringified array of utc timestamps 1 specific or 2 for range

// eslint-disable-next-line max-statements
export function generateQuery({id, correlationId, queueItemState, creationTime, modificationTime, skip, limit}) {
  const doc = {};

  if (skip) { // eslint-disable-line functional/no-conditional-statements
    doc.skip = skip; // eslint-disable-line functional/immutable-data
  }

  if (limit) { // eslint-disable-line functional/no-conditional-statements
    doc.limit = limit; // eslint-disable-line functional/immutable-data
  }

  // We parse both 'id' and 'correlationId' in query as correlationId in Mongo

  if (id) { // eslint-disable-line functional/no-conditional-statements
    doc.correlationId = sanitize(id); // eslint-disable-line functional/immutable-data
  }

  if (correlationId) { // eslint-disable-line functional/no-conditional-statements
    doc.correlationId = sanitize(correlationId); // eslint-disable-line functional/immutable-data
  }

  // we could have here also final: ABORT, DONE, ERROR, active: !final
  if (queueItemState) { // eslint-disable-line functional/no-conditional-statements
    doc.queueItemState = queueItemState; // eslint-disable-line functional/immutable-data
  }

  if (creationTime) {
    const timestampArray = JSON.parse(creationTime);
    if (creationTime.length === 1) { // eslint-disable-line functional/no-conditional-statements
      doc.creationTime = formatTime(timestampArray[0]); // eslint-disable-line functional/immutable-data
    } else { // eslint-disable-line functional/no-conditional-statements
      doc.$and = [ // eslint-disable-line functional/immutable-data
        {creationTime: {$gte: formatTime(timestampArray[0])}},
        {creationTime: {$lte: formatTime(timestampArray[1])}}
      ];
    }
  }

  if (modificationTime) {
    const timestampArray = JSON.parse(modificationTime);
    if (modificationTime.length === 1) { // eslint-disable-line functional/no-conditional-statements
      doc.modificationTime = formatTime(timestampArray[0]); // eslint-disable-line functional/immutable-data
    } else { // eslint-disable-line functional/no-conditional-statements
      doc.$and = [ // eslint-disable-line functional/immutable-data
        {modificationTime: {$gte: formatTime(timestampArray[0])}},
        {modificationTime: {$lte: formatTime(timestampArray[1])}}
      ];
    }
  }

  return doc;

  function formatTime(timestamp) {
    logger.debug(`Timestamp: ${timestamp}`);
    // Ditch the timezone
    const time = moment.utc(timestamp);
    logger.silly(time);
    return time.toDate();
  }
}

export function generateShowParams({showAll = 0, showOperations = undefined, showOperationSettings = undefined, showRecordLoadParams = undefined, showImportJobState = undefined}) {
  if (parseBoolean(showAll)) {
    return {_id: 0};
  }

  const paramsArray = [
    {showOperations: showOperations ? showOperations : false},
    {showOperationSettings: showOperationSettings ? showOperationSettings : false},
    {showRecordLoadParams: showRecordLoadParams ? showRecordLoadParams : false},
    {showImportJobState: showImportJobState ? showImportJobState : false}
  ].filter(param => param);

  return Object.assign({_id: 0}, ...paramsArray);
}


/*
export function generateShowParams({showAll = 0, showOperations = 0, showOperationSettings = 0, showRecordLoadParams = 0, showImportJobState = 0}) {
  if (parseBoolean(showAll)) {
    return {showOperations: 1, showOperationSettings: 1, showRecordLoadParams: 1, showImportJobState: 1};
  }

  return {showOperations, showOperationSettings, showRecordLoadParams, showImportJobState};
}
*/
