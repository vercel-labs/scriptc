import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// Own properties added to a runtime handle reach a property table keyed by
// the native handle (scr_dyn_handle_props.c), but a key that names a class
// member stays refused: typed code compiles `d.toString()`, `m.get(...)`,
// `re.test(s)` and `re.lastIndex` to native entry points that never look
// for an own property, so accepting the write would diverge silently.
// Object.freeze of a RegExp and a graph walker reaching a handle with added
// properties refuse for the same reason: those consumers cannot see the
// table yet.
async function run(source: string): Promise<{ stdout: string; stderr: string }> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-handle-member-refusals-"));
  const entry = join(outDir, "main.mjs");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return { stdout: "", stderr: "" };
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

test("member keys, freeze and the graph walkers refuse a handle's own properties", async () => {
  const { stdout, stderr } = await run(`"use strict";
function attempt(label, run) {
  try { run(); process.stdout.write(label + " no error\\n"); }
  catch (error) { process.stdout.write(label + " " + error.message + "\\n"); }
}
attempt("member set", () => { const d = new Date(0); d.toString = () => "x"; });
attempt("member define", () => { const m = new Map(); Object.defineProperty(m, "get", { value: 1 }); });
attempt("inspect", () => { const d = new Date(0); d.x = 1; console.log(d); });
attempt("diamond", () => { const d = new Date(0); d.x = 1; const g = { d }; g.left = g; g.right = g; console.log(g); });
attempt("diamond list", () => { const d = new Date(0); d.x = 1; const g = { d }; g.left = g; g.right = g; console.log("a", g, g); });
attempt("freeze", () => { const r = /a/; r.x = 1; Object.freeze(r); });
`);
  expect(stdout).toBe(
    [
      "member set setting 'toString' on a dynamic Date is not supported yet",
      "member define Object.defineProperty of the Map member 'get' is not supported yet",
      "inspect console.log/util.inspect of a Date, RegExp, Map, Set or buffer with added own properties is not supported yet",
      "diamond console.log/util.inspect of a Date, RegExp, Map, Set or buffer with added own properties is not supported yet",
      "diamond list console.log/util.inspect of a Date, RegExp, Map, Set or buffer with added own properties is not supported yet",
      "freeze Object.freeze of a RegExp is not supported yet",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("a program without handle writes keeps the integrity fence", async () => {
  const { stderr } = await run(`"use strict";
function f(o) { return Object.isExtensible(o); }
console.log(f(new Date(0)));
`);
  expect(stderr).toContain("Object.isExtensible of a Date is not supported yet");
});
