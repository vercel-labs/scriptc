import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkPreflight, loadProgram } from "../../src/frontend/program.js";
import { tsgoPath } from "../../src/frontend/shared.js";
import { CheckerFacade } from "../../src/frontend/ts7/checker.js";
import type { Checker, Project } from "typescript/unstable/sync";

describe("tsgo virtual filesystem paths", () => {
  test("matches slash-normalized Windows callback paths", () => {
    expect(tsgoPath("C:\\Users\\Alice\\project\\tsconfig.json", "win32"))
      .toBe("C:/Users/Alice/project/tsconfig.json");
    expect(tsgoPath("C:/Users/Alice/project/tsconfig.json", "win32"))
      .toBe("C:/Users/Alice/project/tsconfig.json");
  });

  test("preserves backslashes that are literal POSIX filename characters", () => {
    expect(tsgoPath("/tmp/project\\name/tsconfig.json", "linux"))
      .toBe("/tmp/project\\name/tsconfig.json");
  });
});

test("preflight batches symbols in deferred TDZ-analysis roots", () => {
  const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const dir = mkdtempSync(join(tempRoot, "scriptc-preflight-batch-"));
  const entry = join(dir, "entry.cjs");
  const locals = Array.from({ length: 24 }, (_, index) => `  const local${index} = ${index};`).join("\n");
  const uses = Array.from({ length: 24 }, (_, index) => `  value += local${index};`).join("\n");
  writeFileSync(entry, `
function before() {
  let value = 0;
${locals}
${uses}
  return required.value + value;
}
before();
const required = require("./dep.cjs");
console.log(required.value);
`);
  writeFileSync(join(dir, "dep.cjs"), "exports.value = 1;\n");

  const load = loadProgram(entry);
  try {
    const program = load.program as unknown as {
      project: Project;
      checkerFacade: CheckerFacade | null;
    };
    const calls: unknown[][] = [];
    const proxy = new Proxy(program.project.checker, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "getSymbolAtLocation" || typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(args);
          return (value as (...values: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as Checker;
    program.checkerFacade = new CheckerFacade(proxy, { project: program.project });

    expect(checkPreflight(load).map((diag) => diag.code)).toContain("SC1013");
    expect(calls.some(([arg]) => Array.isArray(arg) && arg.length > 24)).toBe(true);
    expect(calls.some(([arg]) => !Array.isArray(arg))).toBe(false);
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adopts tsconfig paths/baseUrl so tsgo resolves aliased imports", () => {
  const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const dir = mkdtempSync(join(tempRoot, "scriptc-preflight-paths-"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strictNullChecks: true, baseUrl: ".", paths: { "@/*": ["./src/*"] } },
    }),
  );
  const srcDir = join(dir, "src");
  mkdirSync(srcDir);
  writeFileSync(join(dir, "entry.ts"), `import { value } from "@/dep";\nconsole.log(value);\n`);
  writeFileSync(join(srcDir, "dep.ts"), "export const value = 1;\n");
  const entry = join(dir, "entry.ts");

  const load = loadProgram(entry);
  try {
    // Before the fix, tsgo never learns about `paths`/`baseUrl` and reports
    // SC0001 "Cannot find module '@/dep'". SC1010 (own resolver has no
    // opinion on bare-specifier aliases outside npm/imports-field) is a
    // separate, pre-existing limitation and is unaffected by this fix.
    const codes = checkPreflight(load).map((diag) => diag.code);
    expect(codes).not.toContain("SC0001");
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
