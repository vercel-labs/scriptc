// An import alias inside a namespace: using the alias uses the import it
// reads, and an alias nothing uses keeps nothing.
import * as lib from "./alias-lib.js";
import * as spare from "./alias-spare.js";
namespace Tools {
  import helper = lib.helper;
  import unused = spare.value;
  export const result = helper();
}
console.log("aliases evaluated");
export const aliased = Tools.result;
