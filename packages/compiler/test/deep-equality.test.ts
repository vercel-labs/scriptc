import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("native deep equality compares built-ins, classes and accessor properties", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-deep-equality-"));
  try {
    const entry = join(dir, "main.cjs");
    writeFileSync(
      entry,
      `
const { isDeepStrictEqual: equal } = require("node:util");
function attempt(a, b) {
  try { console.log(equal(a, b)); }
  catch (error) { console.log(error.name, error.code, error.message); }
}
class Value { value = 1; }
attempt(new Value(), new Value());
attempt(new Map([[1, 2]]), new Map([[1, 2]]));
attempt(new Set([1]), new Set([1]));
attempt(new Error("fail"), new Error("fail"));
attempt({ get value() { return 1; } }, { value: 1 });
const ctor = () => 1;
attempt({ constructor: ctor }, { constructor: ctor });
console.log("after");
`,
    );
    const result = await compile(entry, {
      sanitize: process.env["SCRIPTC_SAN"] === "1",
      outDir: dir,
      outPath: join(dir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const child = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stderr).toBe("");
    expect(child.stdout).toBe(
      "true\n" +
        "true\n" +
        "true\n" +
        "true\n" +
        "true\n" +
        "TypeError SC2020 util.isDeepStrictEqual over native own constructor functions is not supported yet\nafter\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
