// @requires-libnode
// A package written as the classic UMD wrapper assigns module.exports inside
// the wrapper function, under a condition, so its export is not a top-level
// statement the build can read. The wrapper is called where it is written:
// its body runs when the module evaluates, and the package runs in a Node
// island. The default import is the function the package exports: callable,
// with its members, and the same value in every module that imports it.
import wordform from "wordform";
import * as ns from "wordform";
import { fromLeft, countLeft } from "./left.ts";
import { fromRight } from "./right.ts";

console.log(wordform("crate", 3), wordform("crate", 1), wordform("box", 2));
console.log(wordform.singular("boxes"), wordform.plural("index"), wordform.version);
console.log(typeof wordform, typeof wordform.singular, wordform.name, wordform.length);

function apply(f: (word: string, count: number) => string, word: string): string {
  return f(word, 2);
}
console.log(apply(wordform, "lamp"), ["kettle", "fox"].map((w) => wordform(w, 2)).join(","));
const held: Array<(word: string, count: number) => string> = [wordform];
console.log(held[0]!("cup", 1));

console.log(fromLeft === fromRight, fromLeft === wordform, ns.default === wordform);
console.log(countLeft("ladder"));

// One module instance: a rule added through one binding is seen through the others.
wordform.addRule("ox", "oxen");
console.log(wordform("ox", 2), fromRight("ox", 2), ns.default.plural("ox"));
