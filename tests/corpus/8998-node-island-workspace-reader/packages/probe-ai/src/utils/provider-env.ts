// Reads a patched member through the CommonJS fs object (pi's
// provider-env.ts:23 shape). A workspace member exported as TypeScript
// source: its exports map has no runnable JavaScript entry, and reaching it
// from a native module by bare subpath must still find the island file.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let loads = 0;

export function loadCount(): number {
  return loads;
}

export function getProbeEnvValue(): string {
  loads++;
  const { readFileSync } = require("node:fs") as {
    readFileSync(path: string, encoding: BufferEncoding): string;
  };
  return readFileSync("/scriptc/does/not/exist", "utf-8");
}
