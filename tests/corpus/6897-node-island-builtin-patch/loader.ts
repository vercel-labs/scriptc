// Patches the CommonJS fs object while a package that reads its data file
// through require("fs") loads, then restores it.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");
type ReadFileSync = typeof fs.readFileSync;
const here = dirname(fileURLToPath(import.meta.url));

export interface LoadResult {
  text: string;
  patchedCalls: number;
  restored: boolean;
}

export async function loadPayload(): Promise<LoadResult> {
  const original: ReadFileSync = fs.readFileSync.bind(fs);
  const mutableFs = fs as { readFileSync: ReadFileSync };
  let patchedCalls = 0;
  const patched = ((...args: Parameters<ReadFileSync>) => {
    patchedCalls++;
    const [file, options] = args;
    if (typeof file === "string" && file.endsWith("payload.txt") && !fs.existsSync(file)) {
      return original(join(here, "fallback", "payload.txt"), options);
    }
    return original(...args);
  }) as ReadFileSync;
  mutableFs.readFileSync = patched;
  let text: string;
  try {
    const mod = (await import("payload-reader")) as { default: { payload: string } };
    text = mod.default.payload.trim();
  } finally {
    mutableFs.readFileSync = original;
  }
  return { text, patchedCalls, restored: fs.readFileSync === original };
}
