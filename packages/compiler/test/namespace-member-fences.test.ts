import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const sanitize = process.env["SCRIPTC_SAN"] === "1";

// Static member calls (`Math.abs(x)`) do not read the namespace objects, so
// a change to a function member's value fences (SC1090) instead of leaving
// those calls with the original. New properties and attribute-only changes
// behave as in Node (corpus 7188).
test("replacing or deleting a namespace member fences", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-namespace-fences-"));
  try {
    const entry = join(dir, "main.js");
    writeFileSync(
      entry,
      `
const m = /** @type {any} */ (Math);
const j = /** @type {any} */ (JSON);
function attempt(label, run) {
  try { console.log(label, run()); } catch (error) { console.log(label, error.code); }
}
attempt("alias", () => { m.abs = () => 0; return "replaced"; });
attempt("direct", () => { Math.max = () => 0; return "replaced"; });
attempt("define", () => Object.defineProperty(m, "min", { value: () => 0 }) === m);
attempt("same", () => Object.defineProperty(m, "min", { value: Math.min, enumerable: true }) === m);
attempt("reflect", () => Reflect.set(j, "parse", () => 0));
attempt("assign", () => Object.assign(m, { floor: 1 }) === m);
attempt("delete", () => delete m.ceil);
attempt("added", () => { m.extra = 5; return m.extra; });
console.log(Math.abs(-1), Math.max(1, 2), Math.min(1, 2), JSON.parse("[3]")[0], Math.floor(1.5), Math.ceil(1.5));
console.log(Object.keys(Math).join(","));
`,
    );
    const result = await compile(entry, {
      backend: "llvm",
      sanitize,
      outDir: dir,
      outPath: join(dir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const child = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(
      [
        "alias SC1090",
        "direct SC1090",
        "define SC1090",
        "same true",
        "reflect SC1090",
        "assign SC1090",
        "delete SC1090",
        "added 5",
        "1 2 1 3 1 2",
        "min,extra",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
