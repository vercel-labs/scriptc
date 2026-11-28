'use strict';
const a = require("./a.js");
const b = require("./b.js");
console.log("a", a.first, typeof a.second, a.sealed());
console.log("b", b.during, b.later());
