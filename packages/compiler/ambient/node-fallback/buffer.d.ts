/* node:buffer — the module spelling of the Buffer/atob/btoa globals.
 * Buffer re-exports the GLOBAL declaration, so an imported binding
 * resolves to the same symbol the lowerings already answer for (and
 * third-party .d.ts files that `import { Buffer } from "node:buffer"` —
 * file-entry-cache in a typed-JS source graph — typecheck). */
declare module "buffer" {
  export function isAscii(input: ArrayBuffer | ArrayBufferView): boolean;
  export function isUtf8(input: ArrayBuffer | ArrayBufferView): boolean;
  export function transcode(source: Uint8Array, fromEncoding: string, toEncoding: string): Buffer;
  export function atob(data: string): string;
  export function btoa(data: string): string;
  export const kMaxLength: number;
  export const kStringMaxLength: number;
  export const Buffer: BufferConstructor;
  export type Blob = globalThis.Blob;
  export type File = globalThis.File;
  export const Blob: typeof globalThis.Blob;
  export const File: typeof globalThis.File;
}

declare module "node:buffer" {
  export * from "buffer";
}
