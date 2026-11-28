// A package written as the classic UMD wrapper assigns module.exports inside
// the wrapper function, then attaches a member to the value it stored. The
// run-time whole-export slot holds what the CommonJS arm chose, so both the
// default import and the member it attached answer Node's values.
import wordform from "wordform";

console.log(wordform("item", 2), wordform.singular("items"));
const held = wordform;
console.log(typeof held);
