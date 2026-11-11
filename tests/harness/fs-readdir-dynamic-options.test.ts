/* readdir's options value can be typed `any` or `unknown`, and its members
 * then only exist at run time. The call site's mapped result type still fixes
 * the answer shape the compiled code can hold (string[] for the names form,
 * Buffer[] for the encoding: 'buffer' form, Dirent rows for withFileTypes).
 * Node would answer a different shape from such a value; handing it to a slot
 * of the call site's type would be a wrong-typed value, so the runtime throws
 * a catchable scriptc error (SC2020) naming the gap. The statically typed
 * options spellings pick the matching form and never reach this check (the
 * corpus programs cover them). */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

async function run(source: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-readdir-dynamic-options-"));
  const entry = join(outDir, "main.ts");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return "";
  const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  // A compiler-emitted fence would append its source location; strip it so
  // the message text is what the check compares.
  return stdout.replace(/ \[SC\d+ at [^\]]*\]/g, "");
}

test("an options value typed any that resolves to another shape throws SC2020", async () => {
  const stdout = await run(`import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-rdyn-"));
writeFileSync(join(dir, "a.txt"), "a");
const buffers: any = JSON.parse('{"encoding":"buffer"}');
const types: any = JSON.parse('{"withFileTypes":true}');

function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "no-throw");
  } catch (e) {
    console.log(label, (e as NodeJS.ErrnoException).code, (e as Error).message);
  }
}

attempt("sync-buffer", () => { fs.readdirSync(dir, buffers); });
attempt("sync-types", () => { fs.readdirSync(dir, types); });

async function main(): Promise<void> {
  try {
    await fsp.readdir(dir, buffers);
    console.log("promise-buffer", "no-throw");
  } catch (e) {
    console.log("promise-buffer", (e as NodeJS.ErrnoException).code, (e as Error).message);
  }
  try {
    await fsp.readdir(dir, types);
    console.log("promise-types", "no-throw");
  } catch (e) {
    console.log("promise-types", (e as NodeJS.ErrnoException).code, (e as Error).message);
  }
}

main();
`);
  expect(stdout).toBe(
    [
      "sync-buffer SC2020 readdir's options value resolved to encoding: 'buffer' at run time, but the call site's type holds strings (the options value's members are only known at run time)",
      "sync-types SC2020 readdir's options value resolved to withFileTypes at run time, but the call site's type holds the names array (the options value's members are only known at run time)",
      "promise-buffer SC2020 readdir's options value resolved to encoding: 'buffer' at run time, but the call site's type holds strings (the options value's members are only known at run time)",
      "promise-types SC2020 readdir's options value resolved to withFileTypes at run time, but the call site's type holds the names array (the options value's members are only known at run time)",
      "",
    ].join("\n"),
  );
});

test("a Buffer-typed call site refuses a value that resolves to string names", async () => {
  const stdout = await run(`import * as fs from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-rdyn-b-"));
writeFileSync(join(dir, "a.txt"), "a");
const strings: any = JSON.parse('{"encoding":"utf8"}');
// The call site is typed as the encoding: 'buffer' form; only the value is
// dynamic, and it resolves to the string names.
const options = strings as { encoding: "buffer" };
try {
  const names = fs.readdirSync(dir, options);
  console.log(names[0].toString("utf8"));
} catch (e) {
  console.log((e as NodeJS.ErrnoException).code, (e as Error).message);
}
`);
  expect(stdout).toBe(
    "SC2020 readdir's options value did not resolve to encoding: 'buffer' at run time, but the call site's type holds Buffers (the options value's members are only known at run time)\n",
  );
});
