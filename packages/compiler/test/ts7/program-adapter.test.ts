import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkPreflight, loadProgram } from "../../src/frontend/program-node.js";
import { tsgoPath } from "../../src/frontend/dts-paths.js";
import * as ts from "../../src/frontend/ts7/adapter.js";
import { CheckerFacade } from "../../src/frontend/ts7/checker.js";
import type { SemanticChecker as Checker } from "../../src/frontend/ts7/semantic-checker.js";
import type { Ts7SessionProject as Project } from "../../src/frontend/ts7/session.js";

describe("tsgo virtual filesystem paths", () => {
  test("matches slash-normalized Windows callback paths", () => {
    expect(tsgoPath("C:\\Users\\Alice\\project\\tsconfig.json", "win32")).toBe(
      "C:/Users/Alice/project/tsconfig.json",
    );
    expect(tsgoPath("C:/Users/Alice/project/tsconfig.json", "win32")).toBe(
      "C:/Users/Alice/project/tsconfig.json",
    );
  });

  test("preserves backslashes that are literal POSIX filename characters", () => {
    expect(tsgoPath("/tmp/project\\name/tsconfig.json", "linux")).toBe(
      "/tmp/project\\name/tsconfig.json",
    );
  });
});

test("preserves leading BOMs in TS7 AST and checker string payloads", () => {
  const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const dir = mkdtempSync(join(tempRoot, "scriptc-ts7-bom-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    [
      'const alone = "\\uFEFF";',
      'const doubled = "\\uFEFF\\uFEFF";',
      "const template = `\\uFEFFvalue`;",
    ].join("\n"),
  );

  const load = loadProgram(entry);
  try {
    const literals: ts.StringLiteralLike[] = [];
    ts.walkPreorder(load.entry, (node) => {
      if (ts.isStringLiteralLike(node)) literals.push(node);
    });
    const expected = ["\uFEFF", "\uFEFF\uFEFF", "\uFEFFvalue"];
    expect(literals.map((literal) => literal.text)).toEqual(expected);

    const checker = load.program.getTypeChecker();
    expect(
      literals.map((literal) => {
        const type = checker.getTypeAtLocation(literal);
        return type.isStringLiteralType() ? type.value : null;
      }),
    ).toEqual(expected);
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retains source-file BOM stripping", () => {
  const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const dir = mkdtempSync(join(tempRoot, "scriptc-ts7-source-bom-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, "\uFEFFconst value = 1;\n");

  const load = loadProgram(entry);
  try {
    expect(load.entry.statements.nodes[0]?.getStart(load.entry)).toBe(0);
    expect(load.entry.text).toBe("const value = 1;\n");
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fallback ambient resolves RequestInfo during preflight", () => {
  const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const dir = mkdtempSync(join(tempRoot, "scriptc-request-info-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    ['const target: RequestInfo = "https://example.invalid/";', "console.log(typeof target);"].join(
      "\n",
    ),
  );

  const load = loadProgram(entry);
  try {
    const diagnostics = checkPreflight(load);
    expect(
      diagnostics,
      diagnostics.map((diag) => `${diag.code}: ${diag.message}`).join("\n"),
    ).toEqual([]);
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight batches symbols in deferred TDZ-analysis roots", () => {
  const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const dir = mkdtempSync(join(tempRoot, "scriptc-preflight-batch-"));
  const entry = join(dir, "entry.cjs");
  const locals = Array.from({ length: 24 }, (_, index) => `  const local${index} = ${index};`).join(
    "\n",
  );
  const uses = Array.from({ length: 24 }, (_, index) => `  value += local${index};`).join("\n");
  writeFileSync(
    entry,
    `
function before() {
  let value = 0;
${locals}
${uses}
  return required.value + value;
}
before();
var required = require("./dep.cjs");
console.log(required.value);
`,
  );
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
    program.checkerFacade = new CheckerFacade(proxy, { project: program.project.checker.project });

    // A var binding keeps the SC1013 fence (Node reads undefined there); a
    // const would compile with initialization checks from the same scan.
    expect(checkPreflight(load).map((diag) => diag.code)).toContain("SC1013");
    expect(calls.some(([arg]) => Array.isArray(arg) && arg.length > 24)).toBe(true);
    expect(calls.some(([arg]) => !Array.isArray(arg))).toBe(false);
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project paths resolve identically in the TS 7 program and scriptc module graph", () => {
  const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const dir = mkdtempSync(join(tempRoot, "scriptc-project-paths-"));
  const src = join(dir, "src");
  mkdirSync(src);
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strictNullChecks: true,
        baseUrl: ".",
        paths: { "@app/*": ["src/*"] },
      },
    }),
  );
  writeFileSync(join(src, "message.ts"), 'export const message = "paths agree";\n');
  const entry = join(dir, "main.ts");
  writeFileSync(entry, 'import { message } from "@app/message";\nconsole.log(message);\n');

  const load = loadProgram(entry);
  try {
    const diagnostics = checkPreflight(load);
    expect(
      diagnostics,
      diagnostics.map((diag) => `${diag.code}: ${diag.message}`).join("\n"),
    ).toEqual([]);
    expect(load.moduleOrder.map((file) => basename(file.fileName))).toEqual([
      "message.ts",
      "main.ts",
    ]);
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inherited project paths stay relative to their declaring config", () => {
  const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const dir = mkdtempSync(join(tempRoot, "scriptc-inherited-paths-"));
  const base = join(dir, "base");
  const app = join(dir, "app");
  mkdirSync(join(base, "src"), { recursive: true });
  mkdirSync(app);
  writeFileSync(
    join(base, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strictNullChecks: true,
        baseUrl: ".",
        paths: { "@base/*": ["src/*"] },
      },
    }),
  );
  writeFileSync(join(base, "src/message.ts"), 'export const message = "inherited paths agree";\n');
  writeFileSync(join(app, "tsconfig.json"), JSON.stringify({ extends: "../base/tsconfig.json" }));
  const entry = join(app, "main.ts");
  writeFileSync(entry, 'import { message } from "@base/message";\nconsole.log(message);\n');

  const load = loadProgram(entry);
  try {
    const diagnostics = checkPreflight(load);
    expect(
      diagnostics,
      diagnostics.map((diag) => `${diag.code}: ${diag.message}`).join("\n"),
    ).toEqual([]);
    expect(load.moduleOrder.map((file) => basename(file.fileName))).toEqual([
      "message.ts",
      "main.ts",
    ]);
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
