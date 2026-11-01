import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// A builtin prototype's existing member belongs to the runtime (t262-da §2.5,
// decision DA-2): typed code calls the native entry point and would never
// observe `Array.prototype.join = f`, so a write, delete or redefinition of
// one refuses with SC1090. A key the table does not name is an ordinary
// property of the extensible objects.
test("replacing or deleting a builtin intrinsic member refuses", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-intrinsic-refusals-"));
  const entry = join(outDir, "main.cjs");
  writeFileSync(
    entry,
    `
function attempt(label, run) {
  try { console.log(label, run()); } catch (error) { console.log(label, error.name, error.code, error.message); }
}
attempt("write", () => { Array.prototype.join = function () { return "x"; }; return "wrote"; });
attempt("delete", () => { delete Map.prototype.get; return "deleted"; });
attempt("define", () => { Object.defineProperty(Map.prototype, "size", { value: 1 }); return "defined"; });
attempt("symbol", () => { delete Map.prototype[Symbol.iterator]; return "deleted-symbol"; });
attempt("new-key", () => { Array.prototype.added = 7; return Array.prototype.added; });
console.log("new-own", Object.hasOwn(Array.prototype, "added"));
console.log("members-intact", [1, 2].join("-"), typeof [].join, new Map().get === Map.prototype.get);
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
  const refused = (label: string): string =>
    `${label} Error SC1090 replacing a builtin prototype or constructor member is not supported yet`;
  expect(stdout).toBe(
    [
      refused("write"),
      refused("delete"),
      refused("define"),
      refused("symbol"),
      "new-key 7",
      "new-own true",
      "members-intact 1-2 function true",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});
