// @env: NODE_NO_WARNINGS=1
const { stripTypeScriptTypes } = require("node:module");
console.log(JSON.stringify(stripTypeScriptTypes("const x: number = 1;")));
console.log(JSON.stringify(stripTypeScriptTypes("const x: number = 1;", { sourceMap: false, sourceUrl: "file.js" })));
for (const [label, run] of [
  ["number", () => stripTypeScriptTypes(42)],
  ["mode", () => stripTypeScriptTypes("let a = 1;", { mode: "nope" })],
  ["map", () => stripTypeScriptTypes("let a = 1;", { sourceMap: true })],
  ["enum", () => stripTypeScriptTypes("enum E { A }")],
]) {
  try { run(); console.log(label, "ok"); } catch (e) { console.log(label, e.name, e.code, JSON.stringify(e.message)); }
}

console.log(JSON.stringify(stripTypeScriptTypes("declare enum E { A }\nconst x = 1;")));
console.log(JSON.stringify(stripTypeScriptTypes("// keeps\ninterface A { b: string }\nconst z = 1;")));
console.log(JSON.stringify(stripTypeScriptTypes("class C { public a = 1; readonly c = 3; static d = 4; }")));
console.log(JSON.stringify(stripTypeScriptTypes("class C implements I { a = 1; }")));
console.log(JSON.stringify(stripTypeScriptTypes("abstract class C { abstract m(): void; }")));
console.log(JSON.stringify(stripTypeScriptTypes("class C { declare x: number; }")));
console.log(JSON.stringify(stripTypeScriptTypes("import { type A, b } from './m';\nconsole.log(b);")));
for (const [label, run] of [
  ["angle", () => stripTypeScriptTypes("const v = <string>someValue;")],
  ["override", () => stripTypeScriptTypes("class C { override m() {} }")],
  ["pp", () => stripTypeScriptTypes("class C { constructor(private x: number) {} }")],
]) {
  try { run(); console.log(label, "ok"); } catch (e) { console.log(label, e.name, e.code, JSON.stringify(e.message)); }
}
const order = [];
const mark = (value) => {
  order.push(value);
  return value;
};
const folded = stripTypeScriptTypes("const a: number = 1;", { ignored: mark("opt") }, mark("arg"));
console.log(JSON.stringify(folded), order.join(","));
console.log(JSON.stringify(stripTypeScriptTypes("namespace N { export type A = string; }\nconst ok = 1;")));
console.log(JSON.stringify(stripTypeScriptTypes("class C { m?() {} x!: number; }")));
console.log(JSON.stringify(stripTypeScriptTypes("function f(a: string): void;\nfunction f(a: any) {}\nf('x');")));
console.log(JSON.stringify(stripTypeScriptTypes("// leading\nimport type { A } from './m';\nconst z = 1;")));
console.log(JSON.stringify(stripTypeScriptTypes("import { type A /* c */, b } from './m';\nconsole.log(b);")));
const errorOrder = [];
const markError = (value) => {
  errorOrder.push(value);
  return value;
};
try {
  stripTypeScriptTypes(42, markError("second"));
} catch (error) {
  console.log(error.code, errorOrder.join(","));
}
