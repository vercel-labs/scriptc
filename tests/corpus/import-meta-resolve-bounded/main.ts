// import.meta.resolve of a specifier the build can bound: a parameter of a
// module-local function every call of which passes a literal, or a choice
// between literals. Each value answers what its literal form answers.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// The workspace-or-installed idiom: a local file when it exists, else the
// module the specifier names.
const resolveLocalOrImport = (relative: string, specifier: string): string => {
  const local = path.join(here, relative);
  if (fs.existsSync(local)) return local;
  return fileURLToPath(import.meta.resolve(specifier));
};
console.log(path.basename(resolveLocalOrImport("helper.ts", "./unused.js")));
console.log(path.basename(resolveLocalOrImport("no/such/a.js", "./helper.ts")));
console.log(path.basename(resolveLocalOrImport("no/such/b.js", "./missing with space.js")));

// Builtins canonicalize to node:, URL-like names normalize, relative names
// are URLs of this module's directory.
function show(specifier: string): string {
  return import.meta.resolve(specifier);
}
console.log(show("fs"), show("node:path"), show("https://example.com/a/../b"));
console.log(show("./helper.ts") === new URL("./helper.ts", import.meta.url).href);

// A choice between literals.
const pick = (builtin: boolean): string => import.meta.resolve(builtin ? "node:os" : "./helper.ts");
console.log(pick(true), path.basename(fileURLToPath(pick(false))));

// A value Node cannot resolve throws where the call runs, not at start-up.
function attempt(specifier: string): string {
  try {
    return import.meta.resolve(specifier);
  } catch (error) {
    return `${(error as NodeJS.ErrnoException).code}: ${(error as Error).message.split("\n")[0]}`;
  }
}
console.log(attempt("node:fs"));
console.log(attempt("definitely-not-installed-here").split(" imported from ")[0]);
