/* The default-locale ICU formatters (scr_intl.c) throw an Error when the
 * ICU data file is missing. Node cannot reach this state (its data is inside
 * the binary), so the test runs the compiled program without the data file
 * beside it and with ICU_DATA pointing at an empty directory: each throw
 * enters the surrounding catch, directly and through a closure, and the
 * program continues after it. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const PROGRAM = `
function attempt(label: string, run: () => string): void {
  try {
    console.log(label, run());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(label, "caught", error instanceof Error, message.includes("icudt78l.dat"));
  }
}
attempt("number", () => (1234.5).toLocaleString());
attempt("date", () => new Date(0).toLocaleString());
attempt("time", () => new Date(0).toLocaleTimeString());
try {
  const text = (42).toLocaleString();
  console.log("direct", text);
} catch {
  console.log("direct caught");
}
console.log("after");
`;

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "a missing ICU data file throws into the surrounding catch",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-intl-missing-data-"));
    try {
      const entry = join(dir, "main.ts");
      writeFileSync(entry, PROGRAM);
      const result = await compile(entry, {
        outPath: join(dir, "out", "main"),
        outDir: join(dir, "out"),
        sanitize: process.env["SCRIPTC_SAN"] === "1",
      });
      expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
      if (!result.ok) return;
      rmSync(join(dirname(result.binaryPath), "icudt78l.dat"), { force: true });
      const empty = join(dir, "no-data");
      mkdirSync(empty);
      const { stdout } = await execFileAsync(result.binaryPath, [], {
        env: { ...process.env, ICU_DATA: empty },
      });
      expect(stdout).toBe(
        [
          "number caught true true",
          "date caught true true",
          "time caught true true",
          "direct caught",
          "after",
          "",
        ].join("\n"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  300_000,
);
