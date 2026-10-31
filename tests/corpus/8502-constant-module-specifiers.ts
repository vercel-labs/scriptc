// Module specifiers the compiler can evaluate: a `const` binding and a `+`
// concatenation of literals name their module exactly as a string literal
// does, so dynamic import() and import.meta.resolve stay build-time
// resolutions instead of computed-specifier refusals.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FS_SPECIFIER = "node:" + "fs";
const PATH_SPECIFIER = "node:path" as const;
const PREFIX = "node:";
const JOIN_SPECIFIER = PREFIX + "path";

async function loadBuiltin(): Promise<void> {
  const fs = await import(FS_SPECIFIER);
  const path = await import(JOIN_SPECIFIER);
  console.log(fs.existsSync("/"), fs.existsSync("/definitely-not-here-xyz"));
  console.log(path.join("a", "b") === join("a", "b"), path.basename("/a/b.ts"));
}

await loadBuiltin();
console.log(import.meta.resolve(PATH_SPECIFIER).startsWith("node:path"));
console.log(import.meta.resolve(FS_SPECIFIER).startsWith("node:fs"));
