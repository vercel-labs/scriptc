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
