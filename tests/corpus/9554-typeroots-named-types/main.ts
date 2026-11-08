// @requires-libnode
/// <reference types="word-kit" />
// A tsconfig with `typeRoots` and `types`: tsc loads the package `types`
// names, resolves a types reference through the type root, and finds a
// module under the type root when no node_modules directory holds
// declarations for it. Two island rounds.
import tinyLines from "tiny-lines";
import { words } from "word-kit";
import { count } from "count-kit";
import * as termCodes from "term-codes";

const rows = tinyLines.parse('{"a":1}\n{"a":2}\n');
console.log(rows.length, count(words("two words")), JSON.stringify(termCodes.eraseLine));
