import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the webstream module decided never to throw. */
export const webstreamNeverThrow: readonly IrLibFn[] = [
  // Readable.toWeb builds the web stream over the readable's chunks; the
  // read it starts runs later, on the promise's reaction.
  "webstream.toWebReadable",
  // Writable.toWeb builds the sink object and the web WritableStream over it;
  // the sink's functions run later, on the web stream's calls.
  "webstream.writableToWeb",
  // Duplex.toWeb builds both adapters over the duplex; their functions run
  // later, on the web streams' calls.
  "webstream.toWebDuplex",
];
