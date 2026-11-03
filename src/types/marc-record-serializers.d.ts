// Temporary ambient type declarations for @natlibfi/marc-record-serializers
// (v11, JS-only, ships no .d.ts). Replace this file with the dependency's
// real types once a typed release is adopted.
declare module '@natlibfi/marc-record-serializers' {
  export const MARCXML: {
    from: (xml: string, options?: {subfieldValues?: boolean}) => Promise<any>;
  };
}
