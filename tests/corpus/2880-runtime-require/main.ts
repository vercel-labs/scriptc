// A createRequire() require whose specifier the build cannot name (SPEC
// §5.4): the program resolves it against the calling module when it runs and
// loads the file through Node.js, so a plugin file written at run time reads
// exactly as it does in Node.js.
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "scriptc-runtime-require-"));
const plugin = join(dir, "plugin.cjs");
writeFileSync(plugin, 'module.exports = { value: 7, greet: (name) => "hi " + name };\n');
const loaded = require(plugin);
console.log("plugin", loaded.value, loaded.greet("plugin"));

// What a file loaded at run time requires in turn is its own: a relative
// specifier resolves from that file's directory, during its first evaluation
// and in a function called after the require returned.
const nested = join(dir, "nested");
mkdirSync(nested);
writeFileSync(join(nested, "helper.cjs"), 'module.exports = { prefix: "helper " };\n');
writeFileSync(join(nested, "late.cjs"), 'module.exports = { value: "late" };\n');
writeFileSync(
  join(nested, "index.cjs"),
  'const helper = require("./helper.cjs");\n' +
    'module.exports = { greet: (name) => helper.prefix + name, late: () => require("./late.cjs").value };\n',
);
const relative = require(join(nested, "index.cjs"));
console.log("nested", relative.greet("plugin"), relative.late());

// A JSON document needs no compiled story: Node.js reads it, and so does this.
const document = join(dir, "data.json");
writeFileSync(document, '{"answer":42}\n');
console.log("json", require(document).answer);

// Node.js's own error for a specifier that resolves to nothing.
try {
  require(join(dir, "missing.cjs"));
} catch (error) {
  const message = String((error as Error).message);
  console.log("missing", (error as { code?: unknown }).code, message.includes("missing.cjs"));
}

// Every argument is evaluated before the require runs, as in Node.js.
let evaluated = 0;
try {
  require((evaluated++, join(dir, "missing.cjs")));
} catch (error) {
  console.log("order", evaluated, (error as { code?: unknown }).code);
}
