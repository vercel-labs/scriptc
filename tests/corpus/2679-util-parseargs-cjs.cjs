// CommonJS namespace/member plumbing reaches the same static parseArgs spoke.
const util = require("node:util");
const parse = require("util").parseArgs;

console.log(JSON.stringify(util.parseArgs({
  args: ["-f", "one", "two"],
  options: { force: { type: "boolean", short: "f" } },
  allowPositionals: true,
})));
console.log(JSON.stringify(parse({ args: ["--x=1"], strict: false, tokens: true })));
console.log("null-strict", JSON.stringify(parse({ args: [], strict: null })));
console.log("null-positionals", JSON.stringify(parse({ args: [], allowPositionals: null })));
console.log("null-negative", JSON.stringify(parse({ args: [], allowNegative: null })));
console.log("null-tokens", JSON.stringify(parse({ args: [], tokens: null })));
console.log("non-string-arg", JSON.stringify(parse(JSON.parse(
  '{"args":[1],"strict":false,"tokens":true}',
))));
console.log("proto-token", JSON.stringify(parse(JSON.parse(
  '{"args":["--__proto__"],"options":{"__proto__":{"type":"boolean"}},"tokens":true}',
))));
console.log("proto-default", JSON.stringify(parse(JSON.parse(
  '{"args":[],"options":{"__proto__":{"type":"boolean","default":true}},"tokens":true}',
))));
console.log("proto-negative", JSON.stringify(parse(JSON.parse(
  '{"args":["--no-__proto__"],"options":{"__proto__":{"type":"boolean"}},"allowNegative":true,"tokens":true}',
))));
console.log("numeric-short-order", JSON.stringify(parse(JSON.parse(
  '{"args":["-x"],"options":{"2":{"type":"boolean","short":"x"},"1":{"type":"boolean","short":"x"}},"tokens":true}',
))));
console.log("numeric-values-order", JSON.stringify(parse({
  args: ["--9", "--2", "--100", "--a"],
  options: {
    "9": { type: "boolean" },
    "2": { type: "boolean" },
    "100": { type: "boolean" },
    a: { type: "boolean" },
  },
  tokens: true,
})));

try {
  parse(JSON.parse('{"args":["--unknown",null]}'));
} catch (error) {
  console.log("tokenize-error", `${error.code}`, error.message);
}
try {
  parse(JSON.parse(
    '{"args":["--name","--",null],"options":{"name":{"type":"string"}}}',
  ));
} catch (error) {
  console.log("consumed-terminator-tokenize-error", `${error.code}`, error.message);
}
try {
  parse(JSON.parse('{"args":[],"options":{"2":{},"1":{}}}'));
} catch (error) {
  console.log("numeric-validation-order", `${error.code}`, error.message);
}

for (const config of [
  null,
  { args: [], strict: 1 },
  { args: [], options: { x: {} } },
  { args: [], options: { x: { type: "boolean", short: "xx" } } },
  { args: [], options: { x: { type: "string", default: false } } },
  { args: 1, strict: 1, options: 1 },
  { args: [], options: { x: { type: "boolean", short: undefined } } },
  { args: [], options: { x: { type: "boolean", multiple: undefined } } },
]) {
  try {
    parse(config);
  } catch (error) {
    console.log("config-error", `${error.code}`, error.message);
  }
}

try {
  parse(JSON.parse(
    '{"args":[],"options":{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{}}}',
  ));
} catch (error) {
  console.log("long-config-error", `${error.code}`, error.message.length);
}
