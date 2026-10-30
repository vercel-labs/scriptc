/// <reference path="./fs.d.ts" />

/* graceful-fs — served as node:fs (it monkeypatches fs and retries on
 * EMFILE/ENFILE; compiled programs call fs directly, without the retry
 * queue). gracefulify is a no-op statement. The @types/graceful-fs shape. */
declare module "graceful-fs" {
  export * from "node:fs";
  export function gracefulify<T>(fsModule: T): T;
}
