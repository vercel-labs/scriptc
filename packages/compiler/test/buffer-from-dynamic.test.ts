import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test.each(["llvm"] as const)(
  "untyped Buffer inputs read Node's object shapes; a class instance keeps its refusal (%s)",
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
  try { console.log("ok", from(value).toString("hex")); }
  catch (error) { console.log(error.name, error.message); }
}
attempt({ valueOf() { console.log("hook"); return "abc"; } });
class Input { length = 0; }
attempt(new Input());
attempt({});
attempt(Object.create(null));
attempt({ length: 2, 0: 300, 1: -1 });
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
      const objectError =
        "TypeError The first argument must be of type string or an instance of Buffer, " +
        "ArrayBuffer, or Array or an Array-like Object. Received an instance of Object\n";
      expect(child.stdout).toBe(
        "hook\nok 616263\n" +
          "Error Buffer.from with an opaque reference is not supported yet\n" +
          objectError +
          "TypeError The first argument must be of type string or an instance of Buffer, " +
          "ArrayBuffer, or Array or an Array-like Object. Received [Object: null prototype] {}\n" +
          "ok 2cff\nafter\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
