'use strict';
const a = require("./a.js");
const b = require("./b.js");
console.log("during", b.during);
console.log("later", b.later(), a.lazy);
