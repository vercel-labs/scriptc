// @requires-libnode
/// <reference types="word-kit" />
// A tsconfig with `typeRoots` and `types`: tsc loads the package `types`
// names, resolves a types reference through the type root, and finds a
// module under the type root when no node_modules directory holds
// declarations for it. Two island rounds.
import { scale } from "pantry-units";
import { words } from "word-kit";
import { count } from "count-kit";
import * as oven from "oven-dial";

const halved = scale([30, 7], 0.5);
console.log(halved.join("+"), count(words("two words")), oven.gasMark(150));
