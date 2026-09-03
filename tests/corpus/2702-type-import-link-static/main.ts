// @exit: 1
// A plain named import is a runtime ESM request even when TypeScript's
// checker resolves the requested binding as an interface. Node's strip-only
// loader rejects the graph at link time before either module evaluates.
import { value, Shape as MissingShape } from "./types.ts";

console.log("never runs", value);
