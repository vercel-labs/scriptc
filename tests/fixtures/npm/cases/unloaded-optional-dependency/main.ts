// An optional dependency the project marks never loaded
// (package.json: "scriptc": { "packages": { "encoding": "unloaded" } }):
// require("encoding") throws Node's MODULE_NOT_FOUND exactly as when the
// package is not installed, so the library takes its absent branch.
// tests/harness/package-shims.test.ts compiles this program with
// `encoding` installed and checks the output is unchanged.
import { hasConverter, requireOutcome, textConverted } from "fetch-optional";

console.log("converter:", hasConverter());
console.log("require:", requireOutcome());
try {
  textConverted("abc");
} catch (err) {
  console.log("textConverted:", (err as Error).message);
}
