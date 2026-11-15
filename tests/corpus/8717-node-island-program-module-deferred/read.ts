// Reads the patched member through the CommonJS fs object when called.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function readThroughRequire(): string {
  const { readFileSync } = require("node:fs") as {
    readFileSync(path: string, encoding: BufferEncoding): string;
  };
  return readFileSync("/scriptc/does/not/exist", "utf-8");
}
