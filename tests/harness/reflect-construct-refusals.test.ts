import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// A typed array's prototype is not part of the value, so a construction
// whose newTarget names another prototype cannot produce the instance Node
// does. Reflect.construct refuses it by name, and so does the same
// construction forwarded through a proxy without a construct trap, which
// used to return a plain typed array. A newTarget whose prototype is the
// constructor's own (the proxy itself, the default) constructs as before.
test("Reflect.construct of a typed array with a foreign newTarget refuses", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-reflect-construct-refusals-"));
  const entry = join(outDir, "main.mjs");
  writeFileSync(
    entry,
    `
function NT() {}
NT.prototype = { marker: 1 };
const P = new Proxy(Uint8Array, {});
function attempt(label, make) {
  try {
    const inst = make();
    console.log(label, inst.length, inst instanceof Uint8Array);
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
}
attempt("direct", () => Reflect.construct(Uint8Array, [2], NT));
attempt("proxy", () => Reflect.construct(P, [2], NT));
attempt("proxy default", () => Reflect.construct(P, [2]));
attempt("proxy as newTarget", () => Reflect.construct(Uint8Array, [2], P));
attempt("new proxy", () => new P(2));
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
  const refused =
    "Error SC2020 Reflect.construct with a newTarget other than the target is not supported yet";
  expect(stdout).toBe(
    [
      `direct ${refused}`,
      `proxy ${refused}`,
      "proxy default 2 true",
      `proxy as newTarget ${refused}`,
      "new proxy 2 true",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});
