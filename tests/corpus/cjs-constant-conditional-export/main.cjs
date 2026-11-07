const sleep = require("./sleep.cjs");
const fallback = require("./fallback.cjs");
const selected = require("./selected.cjs");

console.log(typeof sleep, sleep());
console.log(typeof fallback, fallback());
console.log(typeof selected, selected());
