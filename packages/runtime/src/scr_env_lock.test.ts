import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// The process environment is shared by every thread: a SHARE_ENV worker and
// its creator read and write one environment at the same time. glibc's
// getenv is not safe against another thread's setenv (it walks, and may walk
// a freed, environ array), so every runtime read goes through scr_getenv,
// which takes the process-environment lock (scr_core.h). This check keeps a
// new raw getenv() out of the runtime's worker code.
const dir = import.meta.dirname;

/** Comments and literals removed, so only code is searched. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

test("runtime sources read the environment only through the locked accessor", () => {
  const offenders: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".c") || file.endsWith(".test.c")) continue;
    // scr_musl.c defines the platform getenv the locked accessor calls.
    if (file === "scr_musl.c") continue;
    let code = codeOf(readFileSync(join(dir, file), "utf8"));
    if (file === "scr_lib.c") {
      // The one read made with the lock already held, inside the copy the
      // locked accessor returns; calling scr_getenv there would recurse.
      const copy = /\bchar \*scr_env_process_copy\([^)]*\) \{[\s\S]*?\n\}/.exec(code);
      expect(copy).not.toBeNull();
      code = code.replace(copy![0], "");
    }
    for (const match of code.matchAll(/(^|[^A-Za-z0-9_])getenv\s*\(/g)) {
      const line = code.slice(0, match.index).split("\n").length;
      offenders.push(`${file}:${line}`);
    }
  }
  expect(offenders).toEqual([]);
});
