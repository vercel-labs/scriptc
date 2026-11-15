// A lazy chunk loader: the program hands an untyped loader a function whose
// result is a Promise of a module namespace, `() => import("./chunk.mjs")`.
// The namespace is not dyn-convertible while the function keeps its own
// return type, so the boundary adapts the promise result to dyn instead of
// refusing the program. The chunk's top-level side effect prints when the
// loader runs, and the second load answers from the module cache.
import { load } from "./loader.mjs";

async function main(): Promise<void> {
  console.log("before load");
  const pending = load(() => import("./chunk.mjs"));
  console.log("loader returned");
  const ns = await pending;
  console.log(ns.value);
  console.log(ns.greet("world"));
  const again = await load(() => import("./chunk.mjs"));
  console.log(again.value);
}

main();
