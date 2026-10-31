// A JavaScript package's parser of mutually recursive generator methods that
// return `yield*` of each other (yaml 2.9.0's parse/parser.js): the checker
// cannot infer their results. Tokens, values passed to next() and return
// values reach each generator in the same order as in Node.
import { parseTokens, drive, spreadTypes, walkAll } from "token-parser";

for (const token of parseTokens("a { b [ c d ] e } f")) console.log(token);
console.log(drive("{ x } y ! z"));
console.log(spreadTypes("[ 1 2 3 ]"));
console.log(await walkAll("a ( b c ) d ( e )"));
