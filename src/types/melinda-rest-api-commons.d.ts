// Temporary ambient type declarations for @natlibfi/melinda-rest-api-commons
// (v5, JS-only, ships no .d.ts). Replace this file with the dependency's real
// types once a typed release (6.x) is adopted. Factory signatures are
// deliberately loose: the operators they return are Mongo/AMQP objects whose
// exact shape will come from the typed package.
declare module '@natlibfi/melinda-rest-api-commons' {
  import {CONVERSION_FORMATS, LOG_ITEM_TYPE, OPERATIONS, QUEUE_ITEM_STATE, CHUNK_SIZE} from '@natlibfi/melinda-rest-api-commons/dist/constants.js';
  export {CONVERSION_FORMATS, LOG_ITEM_TYPE, OPERATIONS, QUEUE_ITEM_STATE, CHUNK_SIZE};
  export function mongoFactory(mongoUri: string, collection?: string, db?: string): Promise<any>;
  export function mongoLogFactory(mongoUri: string, dbName?: string): Promise<any>;
  export function amqpFactory(amqpUrl: string, runHealthCheck?: boolean): Promise<any>;
  export function conversions(): any;
  /** Logs an error (Error instance, string, or any other thrown value). */
  export function logError(err: unknown): void;
}

declare module '@natlibfi/melinda-rest-api-commons/dist/constants.js' {
  // Shapes copied from node_modules/@natlibfi/melinda-rest-api-commons
  // (v5) dist/constants.js. The string index signatures allow the
  // dynamic-key lookups the JS code already performs.
  export const CONVERSION_FORMATS: {
    MARCXML: string;
    ISO2709: string;
    JSON: string;
    ALEPHSEQ: string;
  } & Record<string, string>;
  export const LOG_ITEM_TYPE: {
    INPUT_RECORD_LOG: string;
    MERGE_LOG: string;
    MATCH_LOG: string;
    RESULT_RECORD_LOG: string;
    SPLITTER_LOG: string;
    LOAD_PROCESS_LOG: string;
  } & Record<string, string>;
  export const OPERATIONS: {
    CREATE: string;
    UPDATE: string;
    FIX: string;
  } & Record<string, string>;
  export const QUEUE_ITEM_STATE: {
    VALIDATOR: {
      PENDING_QUEUING: string;
      PENDING_VALIDATION: string;
      QUEUING_IN_PROGRESS: string;
      UPLOADING: string;
      VALIDATING: string;
      WAITING_FOR_RECORDS: string;
    } & Record<string, string>;
    IMPORTER: {
      IMPORTING: string;
      IN_PROCESS: string;
      IN_QUEUE: string;
    } & Record<string, string>;
    DONE: string;
    ERROR: string;
    ABORT: string;
  };
  export const CHUNK_SIZE: number;
}
