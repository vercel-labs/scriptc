// @requires-libnode
// util.promisify of island functions runs Node's own promisify in the
// island (scope-B NI-5b): callback-style island APIs, bound methods and
// util.promisify.custom all become promise-returning island functions.
import * as util from "node:util";
import { promisify } from "node:util";
import { custom, readValue, Store } from "cb-pkg";

const read = promisify(readValue);
const store = new Store();
const get = util.promisify(store.get.bind(store));
const viaCustom = promisify(custom);

async function main(): Promise<void> {
  console.log("read", await read("a"), await read("b"));
  console.log("get", await get("x"));
  console.log("custom", await viaCustom());
  try {
    await read("missing");
  } catch (e) {
    console.log("rejected", (e as Error).message, (e as NodeJS.ErrnoException).code);
  }
}

main();
