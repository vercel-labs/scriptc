/* module.stripTypeScriptTypes reports Node's ExperimentalWarning on its first
 * call — the pid-prefixed line and the --trace-warnings hint — and only once
 * per process, whatever the call count. The differential corpus runs with
 * NODE_NO_WARNINGS=1 (Node silences warnings there, and so does the compiled
 * program), so the warning's own text is pinned here. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

describe("stripTypeScriptTypes experimental warning", () => {
  test("prints Node's two lines once per process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-strip-warning-"));
    const file = join(dir, "main.cjs");
    writeFileSync(
      file,
      [
        'const mod = require("node:module");',
        'mod.stripTypeScriptTypes("const a: number = 1;");',
        "mod.stripTypeScriptTypes(\"const b: string = 'x';\");",
        'console.log("done");',
        "",
      ].join("\n"),
    );
    const result = await compile(file, {
      outPath: join(dir, "program"),
      outDir: dir,
      backend: "llvm",
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const run = spawnSync(join(dir, "program"), [], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("done\n");
    const lines = run.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^\(node:\d+\) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time$/,
    );
    expect(lines[1]).toBe(
      "(Use `node --trace-warnings ...` to show where the warning was created)",
    );
  }, 300_000);
});
