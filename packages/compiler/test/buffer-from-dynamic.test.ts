import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test.each(["llvm"] as const)(
  "untyped Buffer inputs run a valueOf answer and refuse an opaque reference (%s)",
  async (backend) => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-buffer-from-"));
    try {
      const entry = join(dir, "main.cjs");
      writeFileSync(
        entry,
        `
/** @param {unknown} value */
function from(value) { return Buffer.from(value); }
function attempt(value) {
  try { from(value); }
  catch (error) { console.log(error.name, error.message); }
}
attempt({ valueOf() { console.log("must not execute hook"); return "abc"; } });
class Input { length = 0; }
attempt(new Input());
console.log("after");
`,
      );
      const result = await compile(entry, {
        backend,
        sanitize: process.env["SCRIPTC_SAN"] === "1",
        outDir: dir,
        outPath: join(dir, "program"),
      });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      const child = spawnSync(result.binaryPath, [], { encoding: "utf8" });
      expect(child.status).toBe(0);
      expect(child.stderr).toBe("");
      // Node runs the object's valueOf and converts its answer; the class
      // instance that is not array-like still names its refusal.
      expect(child.stdout).toBe(
        "must not execute hook\n" +
          "Error Buffer.from with an opaque reference is not supported yet\nafter\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
