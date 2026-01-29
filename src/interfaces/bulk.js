import httpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as HttpError, parseBoolean} from '@natlibfi/melinda-commons';
import {mongoFactory, amqpFactory, QUEUE_ITEM_STATE, OPERATIONS, CHUNK_SIZE} from '@natlibfi/melinda-rest-api-commons';
import {CONTENT_TYPES} from '../config.js';
import {generateQuery, generateShowParams} from './utils.js';
// import {inspect} from 'util';

export default async function ({mongoUri, amqpUrl}) {
  const logger = createLogger();
  const mongoOperator = await mongoFactory(mongoUri, 'bulk');
  const amqpOperator = await amqpFactory(amqpUrl, true);

  return {create, addRecord, addRecords, getState, updateState, doQuery, readContent, remove, removeContent};

  async function create({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, operationSettings, stream}) {
    logger.debug(`Bulk: create`);
    logger.debug(`${correlationId}, ${cataloger}, ${oCatalogerIn}, ${operation}, ${contentType}, ${JSON.stringify(recordLoadParams)}, ${JSON.stringify(operationSettings)}`);
    const result = await mongoOperator.createBulk({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream, operationSettings, prio: false});
    if (!stream) {
      logger.verbose(`NoStream bulk ready to receive records ${correlationId}!`);
      return result;
    }

    logger.verbose(`Stream uploaded for ${correlationId}!`);

    logger.silly(`Updating current state of ${correlationId} to ${QUEUE_ITEM_STATE.VALIDATOR.PENDING_QUEUING}`);
    const setStateResult = await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.VALIDATOR.PENDING_QUEUING});
    logger.silly(JSON.stringify(setStateResult));
    const resultCorrelationId = setStateResult.value?.correlationId || setStateResult.correlationId || undefined;
    logger.silly(`resultCorrelationId: ${resultCorrelationId}`);
    if (!resultCorrelationId) {
      throw new HttpError(httpStatus.INTERNAL_SERVER_ERROR, `Could not update state for correlationId ${correlationId}. Result: ${JSON.stringify(setStateResult)}`);
    }
    return setStateResult;
  }

  // DEVELOP: syncronize addRecord and addRecords
  async function addRecord({correlationId, contentType, data}) {

    // addBlobSize increases blobSize by 1 and returns the queueItem if there's a queueItem in state WAITING_FOR_RECORDS for correlationId
    const addBlobSizeResult = await mongoOperator.addBlobSize({correlationId});
    logger.silly(`addBlobSizeResult: ${JSON.stringify(addBlobSizeResult)}`);
    const queueItem = addBlobSizeResult.value || addBlobSizeResult;

    if (!queueItem) {
      throw new HttpError(httpStatus.NOT_FOUND, `Invalid queueItem ${correlationId} for adding records`);
    }

    // addBlobSize already checked the queueItemState, so this should not happen ever
    if (queueItem.queueItemState !== QUEUE_ITEM_STATE.VALIDATOR.WAITING_FOR_RECORDS) {
      throw new HttpError(httpStatus.BAD_REQUEST, `Invalid state (${queueItem.queueItemState}) for adding records in queueItem ${correlationId}`);
    }

    if (data) {

      const type = contentType;
      const {conversionFormat} = CONTENT_TYPES.find(({contentType, allowBulk}) => contentType === type && allowBulk === true);

      if (!conversionFormat) {
        throw new HttpError(httpStatus.UNSUPPORTED_MEDIA_TYPE, `Invalid content-type`);
      }

      const {operation, cataloger, operationSettings, blobSize} = queueItem;
      const currentSequence = blobSize + 1;
      const headers = {correlationId, operation, format: conversionFormat, cataloger, operationSettings, recordMetadata: {blobSequence: currentSequence}};

      logger.debug(`Adding record ${currentSequence} for ${correlationId}`);

      const queue = `${QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION}.${correlationId}`;
      await amqpOperator.sendToQueue({queue, correlationId, headers, data});

      return {status: httpStatus.CREATED, payload: `Record has been added to bulk ${correlationId} that has currently ${currentSequence} records`};
    }

    throw new HttpError(httpStatus.BAD_REQUEST, 'No record.');
  }

  // DEVELOP: syncronize addRecord and addRecords
  async function addRecords({correlationId, contentType, data}) {

    if (!data) {
      throw new HttpError(httpStatus.BAD_REQUEST, 'No records.');
    }

    // get conversionFormat and check that we have contentType that can be handled - this might be a duplicate check?
    // NOTE: currently we handle just application/json for addRecords (array of marc-record-js)!
    // DEVELOP: handling MARCXML and marc21
    const conversionFormat = getConversionFormatForAddRecords(contentType);

    // get QueueItem and check that its in WAITING_FOR_RECORDS state
    const queueItem = await getQueueItemForAddRecords();
    const {operation, cataloger, operationSettings, blobSize} = queueItem;


    // parse data to an array
    // NOTE: this works just for application/json arrays of marc-record-js
    // DEVELOP: handle MARCXML, marc21 and alephSequential
    // DEVELOP: use splitter (toMarcRecords from melinda-rest-api-validator)
    // check that array size is not greater than CHUNK_SIZE

    const dataArray = parseDataAndCheckArray(data);
    const dataSize = dataArray.length;
    let currentSequence = blobSize;

    dataArray.forEach(async (data) => {
      currentSequence += 1;
      const headers = {correlationId, operation, format: conversionFormat, cataloger, operationSettings, recordMetadata: {blobSequence: currentSequence}};

      logger.debug(`Adding record ${currentSequence} for ${correlationId}`);

      const queue = `${QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION}.${correlationId}`;
      await amqpOperator.sendToQueue({queue, correlationId, headers, data});
    });

    const setBlobSizeResult = await mongoOperator.setBlobSize({correlationId, blobSize: currentSequence});
    logger.silly(`setBlobSizeResult: ${JSON.stringify(setBlobSizeResult)}`);

    return {status: httpStatus.CREATED, payload: `Records (${dataSize}) have been added to bulk ${correlationId} that has currently ${currentSequence} records`};

    function getConversionFormatForAddRecords(contentType) {
      logger.silly(`contentType: ${contentType}`);
      const type = contentType;
      const conversionFormatResult = CONTENT_TYPES.find(({contentType, allowAddRecords}) => contentType === type && allowAddRecords === true);
      logger.silly(`conversionFormatResult: ${JSON.stringify(conversionFormatResult)}`);
      if (!conversionFormatResult) {
        throw new HttpError(httpStatus.UNSUPPORTED_MEDIA_TYPE, `Invalid content-type`);
      }
      const {conversionFormat} = conversionFormatResult;
      return conversionFormat;
    }

    async function getQueueItemForAddRecords() {
      logger.debug(`Getting current state of${correlationId}`);
      const queueItem = await mongoOperator.queryById({correlationId, checkModTime: false});
      logger.silly(`Result from query: ${JSON.stringify(queueItem)}`);

      if (!queueItem) {
        throw new HttpError(httpStatus.NOT_FOUND, `Invalid queueItem ${correlationId} for adding records`);
      }

      if (queueItem.queueItemState !== QUEUE_ITEM_STATE.VALIDATOR.WAITING_FOR_RECORDS) {
        throw new HttpError(httpStatus.BAD_REQUEST, `Invalid state (${queueItem.queueItemState}) for adding records in queueItem ${correlationId}`);
      }
      return queueItem;
    }

    function parseDataAndCheckArray(data) {
      const dataArray = parseData(data);
      if (Array.isArray(dataArray)) {
        // check that array size is not greater than CHUNK_SIZE
        const dataSize = dataArray.length;
        if (dataSize > CHUNK_SIZE) {
          throw new HttpError(httpStatus.BAD_REQUEST, `Too many (more than ${CHUNK_SIZE}) records (${dataSize})`);
        }
        return dataArray;
      }
      throw new HttpError(httpStatus.BAD_REQUEST, `Input is not a valid array of marc-record-js`);
    }

    function parseData(data) {
      try {
        logger.debug(`data: ${data}`);
        const dataArray = JSON.parse(data);
        logger.debug(`dataArray: ${JSON.stringify(dataArray)}`);
        return dataArray;
      } catch (error) {
        logger.debug(`Parsing data errored ${error}`);
        throw new HttpError(httpStatus.BAD_REQUEST, error.message);
      }

    }
  }


  async function getState(params) {
    logger.debug(`Getting current state of ${params.correlationId}`);

    const result = await mongoOperator.query(params);
    logger.silly(`Result from query: ${JSON.stringify(result)}`);

    if (!result || result.length < 1) {
      throw new HttpError(httpStatus.NOT_FOUND, `Item not found for id: ${params.correlationId}`);
    }

    const [{correlationId, queueItemState, modificationTime}] = result;

    if (queueItemState && correlationId && modificationTime) {
      return {status: httpStatus.OK, payload: {correlationId, queueItemState, modificationTime}};
    }

    throw new HttpError(httpStatus.NOT_FOUND, `Item not found for id: ${params.correlationId}`);
  }

  async function updateState({correlationId, state}) {
    logger.debug(`Updating current state of ${correlationId} to ${state}`);
    //const {value} = await mongoOperator.setState({correlationId, state});
    const setStateResult = await mongoOperator.setState({correlationId, state});
    const value = setStateResult.value || setStateResult;
    if (value) {
      const {queueItemState, modificationTime} = value;
      return {status: httpStatus.OK, payload: {correlationId, queueItemState, modificationTime}};
    }

    throw new HttpError(httpStatus.NOT_FOUND, `Item not found for id: ${correlationId}`);
  }

  function readContent(correlationId) {
    logger.debug(`Reading content for ${correlationId}`);
    if (correlationId) {
      return mongoOperator.readContent(correlationId);
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  function remove({oCatalogerIn, correlationId}) {

    if (correlationId) {
      const removeResult = mongoOperator.remove({oCatalogerIn, correlationId});
      return removeResult;
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  function removeContent({oCatalogerIn, correlationId}) {
    if (correlationId) {
      const removeContentResult = mongoOperator.removeContent({oCatalogerIn, correlationId});
      return removeContentResult;
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  async function doQuery(incomingParams) {
    const params = generateQuery(incomingParams);
    const showParams = generateShowParams(incomingParams);
    const {recordsAsReport, noRecords, noIds} = incomingParams;
    const report = recordsAsReport === undefined ? false : parseBoolean(recordsAsReport);
    const removeRecords = noRecords === undefined ? false : parseBoolean(noRecords);
    const removeIds = noIds === undefined ? false : parseBoolean(noIds);

    logger.debug(`Queue items querried with params: ${JSON.stringify(params)}, showParams: ${JSON.stringify(showParams)}`);

    if (params) {
      const result = await mongoOperator.query(params, showParams);
      if (report || removeRecords || removeIds) {
        logger.debug(`Reducing recordItems to recordReport`);
        return result.map(queueItem => createRecordReport({queueItem, report, removeRecords, removeIds}));
      }
      return result;
    }

    throw new HttpError(httpStatus.BAD_REQUEST);
  }

  function createRecordReport({queueItem, report = true, removeRecords = true, removeIds = true}) {

    if (!report && !removeRecords && !removeIds) {
      logger.silly(`Returning queueItem as it is`);
      return queueItem;
    }

    const {records, handledIds, rejectedIds, ...rest} = queueItem;
    logger.debug(`We have ${records.length} records to report`);

    if (!report) {
      if (removeRecords) {
        if (removeIds) {
          logger.silly(`Removing records and ids.`);
          return {...rest};
        }
        logger.silly(`Removing records.`);
        return {...rest, handledIds, rejectedIds};
      }

      if (!removeRecords) {
        logger.silly(`Removing ids.`);
        if (removeIds) {
          return {...rest, records};
        }
        logger.silly(`Returning queueItem as it is`);
        return queueItem;
      }
    }

    if (report) {
      logger.silly(`Creating record report`);
      const recordReport = {
        recordAmount: records.length,
        recordStatuses: reportRecordStatuses(records)
      };

      if (removeRecords) {
        if (removeIds) {
          logger.silly(`Returning report and removing records and ids`);
          return {...rest, recordReport};
        }
        logger.silly(`Returning report and removing records`);
        return {...rest, recordReport, handledIds, rejectedIds};
      }

      if (!removeRecords) {
        if (removeIds) {
          logger.silly(`Returning report and records, and removing ids`);
          return {...rest, recordReport, records};
        }
        logger.silly(`Returning report and queueItem as it is`);
        return {queueItem, recordReport};
      }
    }
  }

  function reportRecordStatuses(records) {
    const recordStatuses = records.reduce((allStatuses, record) => {
      logger.silly(`Handling record: ${JSON.stringify(record)}`);
      logger.silly(`Current allStatuses: ${JSON.stringify(allStatuses)}`);

      if (record.recordStatus in allStatuses) {
        logger.silly(`We have an existing status: ${record.recordStatus}`);
        return {
          ...allStatuses,
          [record.recordStatus]: allStatuses[record.recordStatus] + 1
        };
      }

      logger.silly(`We have a new status: ${record.recordStatus}`);
      return {
        ...allStatuses,
        [record.recordStatus]: 1
      };
    }, {});

    logger.silly(JSON.stringify(recordStatuses));
    return recordStatuses;
  }
}

