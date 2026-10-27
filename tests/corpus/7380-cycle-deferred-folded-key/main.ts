// A cycle member runs user code before it declares a constant that only
// functions read, one of them as a computed key and one under `typeof`
// (both resolved from the constant's literal type). Nothing calls those
// functions before the declaration ran, so they read the constant
// normally once the other member's top level calls them.
import { marked } from "./core.ts";
import { describe, kind, mark } from "./util.ts";

console.log(JSON.stringify(marked), kind());
console.log(JSON.stringify(mark({ seen: false })), describe());
