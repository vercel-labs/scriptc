/* node:module's compile cache family where a compiled program and Node
 * differ by design: without NODE_DISABLE_COMPILE_CACHE Node turns its cache
 * on (status ENABLED, a directory), and a compiled program, which loads no
 * JavaScript, answers DISABLED with its own message and makes no directory.
 * The corpus programs module-compile-cache-* pin everything Node and the
 * binary agree on, with the variable set. */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const SOURCE = `
import { enableCompileCache, getCompileCacheDir, flushCompileCache, constants } from "node:module";
const directory = process.argv[2]!;
const result = enableCompileCache(directory);
console.log(JSON.stringify(result), result.status === constants.compileCacheStatus.DISABLED);
console.log(getCompileCacheDir() === undefined, flushCompileCache() === undefined);
`;

test("enableCompileCache answers DISABLED in a compiled program and makes no directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-module-compile-cache-"));
  const entry = join(dir, "main.ts");
  writeFileSync(entry, SOURCE);
  const result = await compile(entry, {
    outPath: join(dir, "main"),
    outDir: dir,
    sanitize: process.env["SCRIPTC_SAN"] === "1",
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const cache = join(dir, "cache");
  const env = { ...process.env };
  delete env["NODE_DISABLE_COMPILE_CACHE"];
  delete env["NODE_COMPILE_CACHE"];
  const native = await execFileAsync(result.binaryPath, [cache], { env });
  expect(native.stderr).toBe("");
  expect(native.stdout).toBe(
    '{"status":3,"message":"Disabled: a natively compiled program has no compile cache"} true\n' +
      "true true\n",
  );
  expect(existsSync(cache)).toBe(false);
  // Node's own wording when the variable is set, as the corpus pins.
  const disabled = await execFileAsync(result.binaryPath, [cache], {
    env: { ...env, NODE_DISABLE_COMPILE_CACHE: "" },
  });
  expect(disabled.stdout).toBe(
    '{"status":3,"message":"Disabled by NODE_DISABLE_COMPILE_CACHE"} true\ntrue true\n',
  );
});
