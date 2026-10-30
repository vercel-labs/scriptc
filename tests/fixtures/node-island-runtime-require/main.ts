// SPEC §5.4's duplicate guard, where the two runs diverge on purpose, so a
// harness test rather than a corpus program. A require whose computed
// specifier names a module this program compiled throws
// ERR_SCRIPTC_DUPLICATE_MODULE; Node.js returns its one instance instead.
// A non-string specifier throws Node.js's own ERR_INVALID_ARG_TYPE.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

interface Store {
  register(name: string): void;
  size(): number;
}

const require = createRequire(import.meta.url);
const store: Store = require("./store.cjs") as Store;
store.register("native");

// Named the way a program names a module at run time: the pieces are not
// string constants, so the build cannot name the file.
const parts = ["store", "cjs"];
const own = fileURLToPath(new URL(`./${parts[0]}.${parts[1]}`, import.meta.url));
try {
  const second = require(own) as Store;
  console.log("loaded", second.size());
} catch (error) {
  console.log("refused", (error as { code?: unknown }).code);
  console.log("detail", String((error as Error).message).includes("second instance"));
}

const number: any = JSON.parse("5");
try {
  require(number);
} catch (error) {
  console.log("value", (error as { code?: unknown }).code, (error as Error).message);
}

console.log("size", store.size());
