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

export function generateQuery({id, queueItemState, creationTime, modificationTime, skip, limit}) {
  const doc = {};

  if (skip) { // eslint-disable-line functional/no-conditional-statement
    doc.skip = skip; // eslint-disable-line functional/immutable-data
  }

  if (limit) { // eslint-disable-line functional/no-conditional-statement
    doc.limit = limit; // eslint-disable-line functional/immutable-data
  }

  if (id) { // eslint-disable-line functional/no-conditional-statement
    doc.correlationId = sanitize(id); // eslint-disable-line functional/immutable-data
  }

  if (queueItemState) { // eslint-disable-line functional/no-conditional-statement
    doc.queueItemState = queueItemState; // eslint-disable-line functional/immutable-data
  }

  if (creationTime) {
    const timestampArray = JSON.parse(creationTime);
    if (creationTime.length === 1) { // eslint-disable-line functional/no-conditional-statement
      doc.creationTime = formatTime(timestampArray[0]); // eslint-disable-line functional/immutable-data
    } else { // eslint-disable-line functional/no-conditional-statement
      doc.$and = [ // eslint-disable-line functional/immutable-data
        {creationTime: {$gte: formatTime(timestampArray[0])}},
        {creationTime: {$lte: formatTime(timestampArray[1])}}
      ];
    }
  }

  if (modificationTime) {
    const timestampArray = JSON.parse(modificationTime);
    if (modificationTime.length === 1) { // eslint-disable-line functional/no-conditional-statement
      doc.modificationTime = formatTime(timestampArray[0]); // eslint-disable-line functional/immutable-data
    } else { // eslint-disable-line functional/no-conditional-statement
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

export function generateShowParams({showAll = 0, showOperations = 0, showOperationSettings = 0, showRecordLoadParams = 0, showImportJobState = 0}) {
  if (parseBoolean(showAll)) {
    return {showOperations: 1, showOperationSettings: 1, showRecordLoadParams: 1, showImportJobState: 1};
  }

  return {showOperations, showOperationSettings, showRecordLoadParams, showImportJobState};
}