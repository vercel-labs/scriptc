// Reads a patched member through the CommonJS fs object (pi's
// provider-env.ts:23 shape): the read must see the patch, as it does in Node.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function readThroughRequire(): string {
  const { readFileSync } = require("node:fs") as {
    readFileSync(path: string, encoding: BufferEncoding): string;
  };
  return readFileSync("/scriptc/does/not/exist", "utf-8");
}
