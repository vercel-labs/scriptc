/* __dirname / __filename in TypeScript files that Node's strip-types rule
 * loads as ES modules: scriptc compiles them to the module's source path,
 * the CommonJS-bundle reading. Node itself has no such globals in an ES
 * module, so the oracle runs a twin of each source with the globals spelled
 * import.meta.dirname / import.meta.filename, at the same paths. */
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const fixture = join(import.meta.dirname, "../fixtures/esm-path-globals");

test("__dirname and __filename in TypeScript ES modules read the module's source path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-esm-path-globals-"));
  cpSync(fixture, join(dir, "src"), { recursive: true });
  const entry = join(dir, "src", "main.ts");
  const result = await compile(entry, {
    outPath: join(dir, "main"),
    outDir: dir,
    sanitize: process.env["SCRIPTC_SAN"] === "1",
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const native = await execFileAsync(result.binaryPath);
  for (const file of [entry, join(dir, "src", "lib", "helper.ts")]) {
    const text = readFileSync(file, "utf8")
      .replaceAll("__dirname", "import.meta.dirname")
      .replaceAll("__filename", "import.meta.filename");
    writeFileSync(file, text);
  }
  const node = await execFileAsync(process.execPath, [entry]);
  expect(native.stdout).toBe(node.stdout);
  expect(native.stdout).toContain("string string\nsrc main.ts\ntrue true\ntrue helper.ts\n");
});
