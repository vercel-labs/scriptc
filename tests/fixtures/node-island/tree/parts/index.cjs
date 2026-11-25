"use strict";
const one = require("./a/one.cjs");
const two = require("./a/b/two.cjs");
const three = require("./c/three.cjs");
exports.sum = () => one.value + two.value + three.value;
