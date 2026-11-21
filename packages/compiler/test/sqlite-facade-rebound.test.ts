import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

/** The lowered program of a CommonJS entry that requires a facade
 * re-exporting node:sqlite, as the JSON text of its IR module. */
async function lowered(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-sqlite-rebound-"));
  const entry = join(dir, "main.cjs");
  await writeFile(join(dir, "facade.cjs"), `module.exports = require("node:sqlite");\n`);
  await writeFile(entry, source);
  const outPath = join(dir, "main.ir.json");
  const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return JSON.stringify(deserializeModule(await readFile(outPath, "utf8")));
}

test("a reassigned require binding dispatches its member call dynamically", async () => {
  // `let f = require("./facade"); f = …` stores the binding's own value, so
  // `f.backup(…)` reads the member from that storage: the module the
  // declaration required is not what runs, and the call must not become the
  // module's backup. (The reassignment itself is a deferred conversion in a
  // compiled program, so this is checked on the lowered IR.)
  const rebound = await lowered(`
let f = require("./facade.cjs");
f = null;
function run(db, path) { return f.backup(db, path); }
function make(path) { return new f.DatabaseSync(path); }
run(null, null);
`);
  expect(rebound).not.toContain('"fn":"sqlite.backup"');
  expect(rebound).not.toContain('"fn":"sqlite.dbNew"');
  // The receiver binding is read from its storage and the member is looked
  // up on it at run time.
  expect(rebound).toContain("%dyn.class.computed");
  expect(rebound).toContain("%reboundReceiver");
});

test("an immutable require binding keeps the facade export shortcut", async () => {
  // The same program with a const binding: there is no storage the file can
  // replace, so the facade's re-export is the module's own backup.
  const plain = await lowered(`
const f = require("./facade.cjs");
function run(db, path) { return f.backup(db, path); }
run(null, null);
`);
  expect(plain).toContain('"fn":"sqlite.backup"');
});
