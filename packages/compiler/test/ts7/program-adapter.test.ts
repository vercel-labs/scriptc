import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkPreflight, loadProgram } from "../../src/frontend/program.js";
import { tsgoPath } from "../../src/frontend/dts-paths.js";
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
