import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// Adoption, the combinators and the conversions of a promise read these
// members from Promise.prototype without consulting its own properties, and
// own properties hold string keys only, so defining one of these keys or a
// symbol-keyed property refuses with a catchable error instead of being
// ignored. Other own properties keep working
// (tests/corpus/promise-own-properties.cjs).
test("promise members the runtime reads from the prototype refuse as own properties", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-promise-refusals-"));
  const entry = join(outDir, "main.mjs");
  writeFileSync(
    entry,
    `
function untyped(value) { return value; }
function attempt(define) {
  try { define(); console.log("defined"); } catch (error) { console.log(error.name, error.message); }
}
const p = untyped(Promise.resolve(1));
const tag = Symbol("tag");
attempt(() => { p.then = () => {}; });
attempt(() => Object.defineProperty(p, "toJSON", { value: () => 1 }));
attempt(() => { p[tag] = 1; });
attempt(() => Object.defineProperty(p, tag, { value: 1 }));
attempt(() => { p.status = "kept"; });
console.log(p.status, Object.keys(p), p[tag], typeof p[Symbol.iterator]);
p.then((value) => console.log("resolved", value));
`,
  );
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return;
  const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  const refused = (key: string): string =>
    `Error defining ${key} on a promise is not supported yet`;
  const symbol = "Error symbol-keyed properties on a promise are not supported yet";
  expect(stdout).toBe(
    [
      refused("then"),
      refused("toJSON"),
      symbol,
      symbol,
      "defined",
      "kept [ 'status' ] undefined undefined",
      "resolved 1",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});
