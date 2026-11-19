// tsc output stamps __esModule on the exports object: a non-enumerable,
// read-only property of the same object every require answers.
"use strict";
const lib = require("./lib");
const take = (m) => m;
console.log(Object.keys(take(lib)).join(","), lib.__esModule, lib.answer, lib.default());
console.log(Object.getOwnPropertyDescriptor(lib, "__esModule"));
lib.answer = 1; console.log(lib.answer, JSON.stringify(lib));
