/* Compiled regex matchers bound every read by the characters left in the
 * subject, so subjects near the runtime's 2^31 - 2 character limit are
 * read only inside the subject. Each matcher runs on a subject of exactly
 * that length whose last byte sits just before an inaccessible page: a
 * bounds check that wraps past INT32_MAX reads that page and faults. The
 * subject is a lazily mapped zero region (no memory is committed for it)
 * with the characters each case needs written near its end. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compileRegexMatcher, REGEX_MATCHER_DECLS } from "../src/backend/llvm/regex-matchers.js";

const LIMIT = 2 ** 31 - 2;

/** [symbol, pattern, flags, start offset from the end, tail text]. */
const CASES: [string, string, string, number, string][] = [
  // The first-character vector search, 10 characters before the end.
  ["seek", "[b-d]", "", 10, "c"],
  // The start filter (two 8-character alternatives), 20 before the end.
  ["filter", "agggtaaa|tttaccct", "i", 20, "TTTACCCT"],
  // A run of 8 literal characters beginning 2 before the end.
  ["run", "xy234567", "", 30, "xy"],
  // A greedy class over the whole subject, 16 characters per step.
  ["greedy", "[^x]+", "", LIMIT, ""],
];

const DRIVER = `
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
void scr_regex_stack_grow(void *a, void *b, void *c, int32_t d) { (void)a; (void)b; (void)c; (void)d; _exit(3); }
void scr_regex_stack_free(void *p) { (void)p; }
${CASES.map(([sym]) => `int32_t ${sym}(const char *, int32_t, int32_t, const char **);`).join("\n")}
static void check(const char *name, int32_t (*m)(const char *, int32_t, int32_t, const char **),
                int32_t start, const char *tail) {
  const int32_t len = ${LIMIT};
  size_t page = (size_t)sysconf(_SC_PAGESIZE);
  size_t body = ((size_t)len + page - 1) / page * page;
  char *base = mmap(NULL, body + page, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  if (base == MAP_FAILED || mprotect(base + body, page, PROT_NONE) != 0) _exit(4);
  char *s = base + (body - (size_t)len);
  memcpy(s + len - strlen(tail), tail, strlen(tail));
  const char *out[16] = {0};
  int32_t found = m(s, len, start, out);
  if (found) printf("%s %ld %ld\\n", name, (long)(out[0] - s), (long)(out[1] - s));
  else printf("%s none\\n", name);
  fflush(stdout);
  munmap(base, body + page);
}
int main(void) {
${CASES.map(([sym, , , back, tail]) => `  check("${sym}", ${sym}, ${LIMIT - back}, ${JSON.stringify(tail)});`).join("\n")}
  return 0;
}
`;

test.skipIf(process.platform === "win32")(
  "compiled regex matchers stay inside subjects near 2^31 characters",
  { timeout: 120_000 },
  () => {
    const lines: string[] = [];
    const decls = new Set(REGEX_MATCHER_DECLS);
    for (const [sym, pattern, flags] of CASES) {
      const code = compileRegexMatcher(sym, pattern, flags, "i64", true);
      if (code === null) throw new Error(`/${pattern}/${flags} did not compile`);
      lines.push(...code.lines.map((line) => line.replace(/^define internal /, "define ")));
      for (const decl of code.decls) decls.add(decl);
    }
    const dir = mkdtempSync(join(tmpdir(), "scriptc-regex-bounds-"));
    try {
      const ir = join(dir, "matchers.ll");
      const driver = join(dir, "driver.c");
      const binary = join(dir, "bounds");
      writeFileSync(ir, [...decls, ...lines, "attributes #0 = { nounwind }", ""].join("\n"));
      writeFileSync(driver, DRIVER);
      execFileSync("clang", ["-O2", "-Wno-override-module", ir, driver, "-o", binary]);
      const output = execFileSync(binary, { encoding: "utf8" });
      expect(output.trim().split("\n")).toEqual([
        `seek ${LIMIT - 1} ${LIMIT}`,
        `filter ${LIMIT - 8} ${LIMIT}`,
        "run none",
        `greedy 0 ${LIMIT}`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
