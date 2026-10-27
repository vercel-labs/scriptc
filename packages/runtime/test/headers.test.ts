import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const srcDir = join(import.meta.dirname, "../src");

/** The module headers scr_runtime.h includes, in include order. */
const MODULE_HEADERS = [
  ...readFileSync(join(srcDir, "scr_runtime.h"), "utf8").matchAll(/^#include "(scr_\w+\.h)"/gm),
].map((m) => m[1]!);

const DEFINE_SETS = [[], ["-DSCR_LIB"], ["-DSCR_LIB", "-DSCR_THREAD_INSTANCES"], ["-DSCR_WORKERS"]];

// Each module header includes what it uses, so a runtime unit can include
// only the headers it needs. A header that relies on an earlier one it does
// not include fails here; -Werror=visibility catches a `struct T *`
// parameter whose tag is not declared at file scope yet.
test("every module header compiles on its own", async () => {
  expect(MODULE_HEADERS.length).toBeGreaterThan(40);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-headers-"));
  try {
    const failures: string[] = [];
    await Promise.all(
      MODULE_HEADERS.map(async (header) => {
        const source = join(dir, `${header}.c`);
        await writeFile(source, `#include "${header}"\n`);
        for (const defines of DEFINE_SETS) {
          try {
            await execFileAsync("clang", [
              "-std=c11",
              "-fsyntax-only",
              "-Werror=visibility",
              "-Werror=implicit-function-declaration",
              ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
              ...defines,
              "-I",
              srcDir,
              source,
            ]);
          } catch (error) {
            failures.push(
              `${header} ${defines.join(" ")}: ${(error as { stderr?: string }).stderr}`,
            );
          }
        }
      }),
    );
    expect(failures).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scr_runtime.h holds no declarations of its own", () => {
  const text = readFileSync(join(srcDir, "scr_runtime.h"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  expect(text.filter((line) => !/^#(include "scr_\w+\.h"|ifndef|define|endif)/.test(line))).toEqual(
    [],
  );
});

// Two-tier invariant I3: the dynamic tier's value representation stays in
// the scr_js_* units. A static runtime unit or module header never includes
// scr_js.h, so no static runtime function can take or return a jsval.
test("only dynamic-tier units include scr_js.h", () => {
  const includers = readdirSync(srcDir)
    .filter((name) => /\.(c|h)$/.test(name))
    .filter((name) => /^#include "scr_js\.h"/m.test(readFileSync(join(srcDir, name), "utf8")));
  expect(includers.filter((name) => !/^scr_js_\w+(\.test)?\.c$/.test(name))).toEqual([]);
  expect(includers).toContain("scr_js_value.c");
});
