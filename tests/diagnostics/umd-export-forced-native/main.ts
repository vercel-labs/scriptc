// A package written as the classic UMD wrapper assigns module.exports inside
// the wrapper function. Marked native, its export has no static form: the use
// of the default import names that cause and the remedy.
import wordform from "wordform";

console.log(wordform("item", 2), wordform.singular("items"));
const held = wordform;
console.log(typeof held);
