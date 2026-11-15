// util.inspect with colors over errors: formatError prints the stack plain
// except for its frames, where a frame naming a builtin module takes the
// whole line in the 'undefined' style, a node_modules package name the
// 'module' style, and the working directory's prefix — the file:// href of
// it when the raw path is not in the line — the 'undefined' style with the
// parenthesis that opens it. A stack with no frame line keeps Node's
// bracket form, which takes no colors, and a property's values style as
// they do anywhere else.
import * as util from "node:util";

const inspect = (value: unknown, options: object = { colors: true }): string => util.inspect(value, options);
const cwd = process.cwd();

const plain = new Error("plain");
plain.stack = `Error: plain\n    at plain (${cwd}/tests/corpus/util-inspect-colors-errors.ts:1:2)`;
console.log(`cwd frame: ${inspect(plain)}`);

const core = new Error("core");
core.stack = [
  "Error: core",
  "    at readFileSync (node:fs:1:1)",
  "    at Object.<anonymous> (node:internal/modules/cjs/loader:1929:14)",
  "    at missing (node:not-a-builtin:1:1)",
  "    at node:path:2:3",
].join("\n");
console.log(`core frames: ${inspect(core)}`);

const modules = new Error("modules");
modules.stack = [
  "Error: modules",
  "    at a (/work/node_modules/pkg/index.js:1:1)",
  "    at b (/work/node_modules/@scope/pkg/lib/x.js:2:2)",
  "    at c (/work/mynode_modules/other/index.js:3:3)",
  "    at d (C:\\work\\node_modules\\winlib\\index.js:4:4)",
].join("\n");
console.log(`module frames: ${inspect(modules)}`);

const href = new Error("href");
href.stack = `Error: href\n    at asHref (file://${cwd}/tests/corpus/util-inspect-colors-errors.ts:5:6)`;
console.log(`href frame: ${inspect(href)}`);

const bracketed = new Error("custom");
bracketed.stack = "custom stack without frames";
console.log(`bracketed: ${inspect(bracketed)}`);

const props = new Error("props");
props.stack = `Error: props\n    at props (${cwd}/tests/corpus/util-inspect-colors-errors.ts:7:8)`;
(props as unknown as { code: string }).code = "E_CODE";
(props as unknown as { count: number }).count = 2;
console.log(`props: ${inspect(props)}`);
console.log(`props nested: ${inspect({ err: props }, { colors: true, depth: 1 })}`);

class Wrapped extends Error {}
const wrapped = new Wrapped("wrapped");
wrapped.stack = `Wrapped [Error]: wrapped\n    at wrapped (${cwd}/tests/corpus/util-inspect-colors-errors.ts:9:10)`;
console.log(`subclass: ${inspect(wrapped)}`);

const cause = new Error("inner");
cause.stack = `Error: inner\n    at inner (${cwd}/tests/corpus/util-inspect-colors-errors.ts:11:12)`;
const outer = new Error("outer", { cause });
outer.stack = `Error: outer\n    at outer (${cwd}/tests/corpus/util-inspect-colors-errors.ts:12:13)`;
console.log(`cause: ${inspect(outer)}`);

console.log(`format: ${util.formatWithOptions({ colors: true }, "%o", cause)}`);
