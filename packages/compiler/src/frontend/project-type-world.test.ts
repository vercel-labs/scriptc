import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkPreflight, loadProgram } from "./program-node.js";

/** A project directory holding `tsconfig.json` and `main.ts`. */
function project(
  tsconfig: Record<string, unknown>,
  source: string,
): { directory: string; file: string } {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-type-world-"));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: tsconfig }));
  const file = join(directory, "main.ts");
  writeFileSync(file, source);
  return { directory, file };
}

// `Document` is a DOM type. next's tsconfig names no `lib`, so tsc derives
// lib.<target>.full, which carries dom. The type world keeps scriptc's own
// libraries; the preflight gate knows what the project's tsc would load and
// admits a DOM name as "the value throws at run time" instead of SC0001.
test("a project without lib gets tsc's default libs for explanation", () => {
  const { directory, file } = project(
    { strict: true, target: "ES2018", noEmit: true },
    "export type Doc = Document\nexport const n: number = 1\n",
  );
  const load = loadProgram(file);
  try {
    expect(checkPreflight(load)).toEqual([]);
    const admitted = (load.admittedOpinions ?? []).filter((site) => site.code === 2304);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]!.view).toBe("throw");
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

// The same program in a project that names its libs keeps that lib set: no
// DOM types appear, and the project sees the name error its own tsc sees.
test("a project with an explicit lib keeps it", () => {
  const { directory, file } = project(
    { strict: true, target: "ES2018", lib: ["ES2020"], noEmit: true },
    "export type Doc = Document\nexport const n: number = 1\n",
  );
  const load = loadProgram(file);
  try {
    const diagnostics = checkPreflight(load);
    expect(diagnostics.some((d) => /Document/.test(d.message))).toBe(true);
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

// A type package the project names is resolved and joins the program, so
// its globals are visible to the checker.
test("a project's named types package is visible", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-type-world-"));
  mkdirSync(join(directory, "node_modules", "@types", "demo"), { recursive: true });
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: ["demo"] } }),
  );
  writeFileSync(
    join(directory, "node_modules", "@types", "demo", "index.d.ts"),
    "interface DemoGlobal { x: number }\n",
  );
  const file = join(directory, "main.ts");
  writeFileSync(file, "export type T = DemoGlobal\nexport const n: number = 1\n");
  const load = loadProgram(file);
  try {
    expect(checkPreflight(load)).toEqual([]);
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

// A DOM value used in code compiles as a value that throws at run time,
// exactly as Node raises ReferenceError for it; the opinion records it.
test("a DOM global used as a value keeps the throws opinion", () => {
  const { directory, file } = project(
    { strict: true, target: "ES2018", noEmit: true },
    "export const title: string = window.document.title\n",
  );
  const load = loadProgram(file);
  try {
    expect(checkPreflight(load)).toEqual([]);
    const admitted = (load.admittedOpinions ?? []).filter((site) => site.code === 2304);
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted.every((site) => site.view === "throw")).toBe(true);
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
