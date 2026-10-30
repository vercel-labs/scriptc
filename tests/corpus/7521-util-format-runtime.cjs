// util.format, util.formatWithOptions and console output over untyped
// values: format strings held in variables and parameters, spread
// arguments, %s over objects with and without their own toString, %d and
// %i coercions, %j over toJSON, and options objects built at run time.
"use strict";
const util = require("util");

function log(message, ...rest) {
  console.log(message, ...rest);
}

function formatAll(format, values) {
  return util.format(format, ...values);
}

const messages = ["%s: %d items", "%s", "%i%%", "%j", "plain text", 42];
for (const message of messages) {
  log(message, "cart", "3.7", { total: 9 });
  console.log(formatAll(message, ["a", 1n]));
}

const withToString = {
  name: "custom",
  toString() {
    return `<${this.name}>`;
  },
};
const inherited = Object.create(withToString);
inherited.name = "inherited";
const fmt = "%s / %s / %s";
console.log(util.format(fmt, withToString, inherited, [1, [2, [3]]]));
console.log(fmt, new Date(0), new Error("boom").message, null, Symbol("s"));

const numeric = "%d %i %f";
console.log(util.format(numeric, "0x1f", "12.9px", "1e3"));
console.log(util.format(numeric, { valueOf: () => 5 }, true, []));
console.log(util.format(numeric, 7n, 8n, 9));

const json = "%j|%j|%j";
const circular = { name: "loop" };
circular.self = circular;
console.log(util.format(json, { toJSON: () => ({ replaced: 1 }) }, circular, undefined));

const options = {};
options.depth = 0;
options.breakLength = 40;
console.log(util.formatWithOptions(options, "%O", { a: { b: 1 } }, ["x", { y: { z: 2 } }]));
options.depth = null;
options.unknownOption = true;
console.log(util.formatWithOptions(options, { a: { b: { c: { d: 1 } } } }));
console.log(util.formatWithOptions({ compact: 1 }, ...[{ k: [1, 2] }, "end"]));
for (const bad of [null, 0, "options", () => {}]) {
  try {
    util.formatWithOptions(bad, "x");
  } catch (error) {
    console.log(error.name, error.code, error.message);
  }
}

const args = ["%s=%s", "key"];
args.push("value", "rest");
console.log(...args);
console.warn(...args);
console.log(util.format(...args.slice(1)));
