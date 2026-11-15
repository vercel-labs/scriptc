// Reads a patched member through the CommonJS fs object (pi's
// provider-env.ts:23 shape), so this module joins the island set. Its only
// clause naming ./env.ts is type-only, which type stripping erases; the
// module it names holds the computed import() of pi's env-api-keys.ts:8.
import { createRequire } from "node:module";
import type { Loader } from "./env.ts";

const require = createRequire(import.meta.url);

export function readThroughRequire(load: Loader): string {
  if (typeof load !== "function") return "no loader";
  const { readFileSync } = require("node:fs") as {
    readFileSync(path: string, encoding: BufferEncoding): string;
  };
  return readFileSync("/scriptc/does/not/exist", "utf-8");
}
