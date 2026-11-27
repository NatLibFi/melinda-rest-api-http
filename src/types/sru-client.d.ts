// Temporary ambient type declarations for @natlibfi/sru-client (v7, JS-only,
// ships no .d.ts). Replace this file with the dependency's real types once a
// typed release is adopted.
declare module '@natlibfi/sru-client' {
  import type {EventEmitter} from 'node:events';
  export default function createSruClient(options: {
    url: string;
    recordSchema?: string;
  }): {
    /** Emits 'record' (MARCXML string per record), 'end', and 'error'. */
    searchRetrieve: (query: string) => EventEmitter;
  };
}
