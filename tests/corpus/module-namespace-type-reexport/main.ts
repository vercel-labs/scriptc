import * as explicit from "./explicit.ts";
import * as mixed from "./mixed.ts";
import * as nested from "./nested.ts";
import * as star from "./star.ts";

// `export type *` forwards types only: Node's namespace object carries the
// module's own value exports, not the type names behind the type-only
// re-export. Explicit `export type { … }` and `export { type … }` behave the
// same way, `export *` forwards only the runtime exports of its target, and
// an explicit value re-export keeps its name.
console.log(Object.keys(star).join(","));
console.log(Object.keys(explicit).join(","));
console.log(Object.keys(mixed).join(","));
console.log(Object.keys(nested).join(","));
console.log(Object.keys(explicit).length);
console.log(explicit.keptValue);
const boxedStar: object = star;
const boxedExplicit: object = explicit;
console.log(Object.keys(boxedStar).join(","));
console.log(Object.keys(boxedExplicit).join(","));
