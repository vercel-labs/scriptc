/* The libraries a project's tsconfig names in `lib` beside scriptc's own
 * (`dom`, `webworker`, …) never join the program that is compiled. They
 * decide which "cannot find name" errors of that program are names the
 * project's own tsc resolves: such a name is an opaque type, and as a value
 * it is absent at run time unless Node defines a global of that name. The
 * projects here live outside the repository, so they have no @types/node
 * and scriptc's bundled Node declarations type them. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { projectOnlyLibraries } from "../src/frontend/program.js";

test("projectOnlyLibraries keeps the libraries scriptc's own set does not hold", () => {
  expect(projectOnlyLibraries(undefined)).toEqual([]);
  expect(projectOnlyLibraries(["es2023", "ES2015.Promise", "es5", "es6", "decorators"])).toEqual(
    [],
  );
  expect(projectOnlyLibraries(["lib.es2025.d.ts", "esnext.disposable", "esnext.array"])).toEqual(
    [],
  );
  expect(projectOnlyLibraries(["es2023", "DOM", "dom.iterable", "lib.dom.d.ts"])).toEqual([
    "lib.dom.d.ts",
    "lib.dom.iterable.d.ts",
  ]);
  expect(projectOnlyLibraries(["esnext", "webworker", "es2026"])).toEqual([
    "lib.esnext.d.ts",
    "lib.webworker.d.ts",
    "lib.es2026.d.ts",
  ]);
});

async function build(lib: readonly string[] | null, source: string) {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-project-lib-"));
  try {
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, ...(lib === null ? {} : { lib }) },
        include: ["main.ts"],
      }),
    );
    await writeFile(join(dir, "main.ts"), source);
    const result = await compile(join(dir, "main.ts"), {
      outDir: join(dir, ".scriptc"),
      outPath: join(dir, ".scriptc", "main.ir.json"),
      outputKind: "ir",
    });
    return result.ok ? [] : result.diagnostics.map((diag) => `${diag.code}: ${diag.message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a name only the project's libraries declare compiles; without the library it is an error", async () => {
  const source = [
    "function widthOf(target: HTMLElement): number {",
    "  return target.offsetWidth;",
    "}",
    'console.log(typeof widthOf, typeof document, typeof window !== "undefined");',
    "console.log(typeof globalThis.document);",
    "",
  ].join("\n");
  expect(await build(["es2023", "dom"], source)).toEqual([]);
  expect(await build(["es2023"], source)).toEqual([
    "SC0001: Cannot find name 'HTMLElement'.",
    "SC0001: Cannot find name 'document'. Do you need to change your target library? Try changing the 'lib' compiler option to include 'dom'.",
    "SC0001: Cannot find name 'window'.",
    "SC0001: Element implicitly has an 'any' type because type 'typeof globalThis' has no index signature.",
  ]);
  expect(await build(null, source)).toHaveLength(4);
});

test("a global Node defines is never treated as absent", async () => {
  // The bundled Node declarations declare none of these names; the DOM
  // library declares all of them, and Node 24 defines each one.
  for (const name of ["navigator", "WebSocket", "BroadcastChannel", "toString"]) {
    expect(await build(["es2023", "dom"], `console.log(typeof ${name});\n`), name).toEqual([
      expect.stringContaining(`SC0001: Cannot find name '${name}'.`),
    ]);
  }
  expect(
    await build(["es2023", "dom"], "console.log(typeof globalThis.navigator);\n"),
  ).toHaveLength(1);
});

test("as a type, such a name is admitted: it names no value", async () => {
  expect(
    await build(
      ["es2023", "dom"],
      [
        "let socket: WebSocket | null = null;",
        "class Feed implements EventListenerObject {",
        "  handleEvent(): void {}",
        "}",
        "console.log(socket === null, typeof Feed);",
        "",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("a name no library declares keeps its error beside admitted ones", async () => {
  expect(await build(["es2023", "dom"], "console.log(typeof document, missingWidget);\n")).toEqual([
    "SC0001: Cannot find name 'missingWidget'.",
  ]);
});
