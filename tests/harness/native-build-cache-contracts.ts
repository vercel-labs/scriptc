/* Build cache contracts of the native compiler: a rebuild answers as a cold
 * build does.
 *
 * A small project with an untyped JavaScript package is built, then edited
 * one way after another. After each edit it is built twice into the same
 * output path: once with the cache the builds before it filled, once with
 * an empty cache. The two executables must be the same bytes, whatever the
 * edit was. Edits that leave every token in place, and every answer the
 * frontend took from the raw text, must also be served without running the
 * frontend; the others must run it.
 *
 * The package matters: it makes method calls in the project's own files
 * dynamic, whose lowering reads call-site text, and its JavaScript is
 * compiled from a rewritten form. Both once kept every comment edit of such
 * a program off the fast path. */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect } from "vitest";

export interface BuildCacheContractOptions {
  /** The native compiler under test. */
  compiler: string;
  /** An empty scratch directory. */
  directory: string;
  /** The environment native compiler processes run in. */
  env: NodeJS.ProcessEnv;
  /** Runs the compiler; resolves with its stderr. */
  run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stderr: string }>;
}

type Files = Record<string, string>;

/** How a rebuild got its frontend result, from its timing lines. */
type Served = "unchanged" | "hit" | "equivalent" | "frontend";

const MAIN = [
  'import assert from "node:assert";',
  'import { describe } from "tiny-shape";',
  'import { label } from "./label.ts";',
  "",
  "class Counter {",
  "  private count = 0;",
  "  add(step: number): number {",
  "    this.count += step;",
  "    return this.count;",
  "  }",
  "}",
  "",
  "async function main(): Promise<void> {",
  "  const counter = new Counter();",
  "  counter.add(2);",
  "  assert(counter.add(0) >= 2);",
  "  const parsed: any = JSON.parse('{\"answer\": 42}');",
  "  // The await of an untyped value.",
  "  const settled = await parsed;",
  "  console.log(label(counter.add(3)), describe(settled));",
  "}",
  "",
  "void main();",
  "",
].join("\n");

const LABEL = [
  "/** A label for a count. */",
  "export function label(count: number): string {",
  '  return "count=" + count;',
  "}",
  "",
].join("\n");

const PACKAGE_INDEX = [
  "function describe(value) {",
  "  var keys = Object.keys(value);",
  '  return keys.join(",") + ":" + String(value[keys[0]]);',
  "}",
  "module.exports = { describe: describe };",
  "",
].join("\n");

const FILES: Files = {
  "main.ts": MAIN,
  "label.ts": LABEL,
  "package.json": '{"name":"cache-contracts","type":"module","private":true}\n',
  "tsconfig.json":
    JSON.stringify({
      compilerOptions: {
        target: "es2024",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        allowImportingTsExtensions: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
    }) + "\n",
  "node_modules/tiny-shape/package.json":
    '{"name":"tiny-shape","version":"1.0.0","main":"index.js","types":"index.d.ts"}\n',
  "node_modules/tiny-shape/index.d.ts": "export function describe(value: unknown): string;\n",
  "node_modules/tiny-shape/index.js": PACKAGE_INDEX,
};

function write(directory: string, files: Files): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), text);
  }
}

export async function checkBuildCacheContracts(options: BuildCacheContractOptions): Promise<void> {
  const project = join(options.directory, "project");
  const warm = join(options.directory, "warm");
  write(project, FILES);
  let colds = 0;

  /** Builds `directory` with the cache named `cache`; the executable's
   * bytes and how the frontend result was obtained. */
  const build = async (
    directory: string,
    cache: string,
    args: string[] = [],
    env: NodeJS.ProcessEnv = {},
  ): Promise<{ bytes: Buffer; served: Served }> => {
    const output = join(directory, "out", "program" + (process.platform === "win32" ? ".exe" : ""));
    const { stderr } = await options.run(
      options.compiler,
      ["build", join(directory, "main.ts"), "-o", output, "--strip", ...args],
      {
        ...options.env,
        SCRIPTC_TIMING: "1",
        SCRIPTC_CACHE_DIR: join(cache, "cache"),
        SCRIPTC_STATE_DIR: join(cache, "state"),
        ...env,
      },
    );
    const phases = new Set(
      [...stderr.matchAll(/^scriptc timing \{"phase":"([^"]+)"/gm)].map((match) => match[1]),
    );
    const served: Served = phases.has("unchanged-build-hit")
      ? "unchanged"
      : phases.has("frontend-cache-hit")
        ? "hit"
        : phases.has("frontend-cache-equivalent")
          ? "equivalent"
          : "frontend";
    expect(served === "frontend", stderr).toBe(phases.has("frontend-cache-miss"));
    return { bytes: readFileSync(output), served };
  };

  /** The rebuild of `directory` with the warm cache, checked against a
   * build with an empty one. */
  const rebuild = async (
    name: string,
    directory: string = project,
    args: string[] = [],
    env: NodeJS.ProcessEnv = {},
  ): Promise<{ bytes: Buffer; served: Served }> => {
    const again = await build(directory, warm, args, env);
    const cold = await build(directory, join(options.directory, `cold-${colds++}`), args, env);
    expect(cold.served, name).toBe("frontend");
    expect(
      again.bytes.equals(cold.bytes),
      `${name}: the rebuilt executable is a cold build's`,
    ).toBe(true);
    return again;
  };

  const first = await build(project, warm);
  expect(first.served).toBe("frontend");
  expect((await rebuild("no edit")).served).not.toBe("frontend");

  // Edits that keep every token and every answer taken from the raw text.
  const kept: [string, Files][] = [
    ["a comment appended", { "main.ts": MAIN + "// The end of the entry.\n" }],
    ["a comment at the top", { "main.ts": "// The entry.\n" + MAIN }],
    [
      "a comment inside a function",
      { "main.ts": MAIN.replace("  counter.add(2);", "  // Start at two.\n  counter.add(2);") },
    ],
    [
      "blank lines and indentation",
      { "main.ts": MAIN.replace("  counter.add(2);", "\n\n      counter.add(2);") },
    ],
    ["a comment in an imported file", { "label.ts": LABEL + "// No other labels.\n" }],
    ["all of them undone", { "main.ts": MAIN, "label.ts": LABEL }],
  ];
  for (const [name, edit] of kept) {
    write(project, edit);
    const again = await rebuild(name);
    expect(again.served, name).toBe("equivalent");
    expect(again.bytes.equals(first.bytes), name).toBe(true);
  }

  // Edits the frontend must see.
  const seen: [string, Files, boolean][] = [
    // The await of an untyped value adopts thenables only in a program
    // whose text can define one, and that scan reads comments.
    ["a comment a text scan matches", { "main.ts": MAIN + "// then: the value settles\n" }, true],
    [
      "a string literal a text scan matches",
      { "main.ts": MAIN.replace('"answer"', '"then"') },
      true,
    ],
    // A failing assert(value) reports its call's source text.
    [
      "whitespace inside a call whose text the output carries",
      { "main.ts": MAIN.replace("counter.add(0) >= 2", "counter.add(0)  >=  2") },
      true,
    ],
    ["a string literal", { "label.ts": LABEL.replace('"count="', '"total="') }, true],
    [
      "an import added",
      {
        "main.ts": 'import { extra } from "./extra.ts";\n' + MAIN + "console.log(extra);\n",
        "extra.ts": "export const extra = 7;\n",
      },
      true,
    ],
    ["an import removed", { "main.ts": MAIN }, true],
    [
      "the dependency's file",
      {
        "node_modules/tiny-shape/index.js": PACKAGE_INDEX.replace('":"', '"="'),
      },
      true,
    ],
    [
      "a comment in the dependency's file",
      {
        "node_modules/tiny-shape/index.js":
          "// describe a value\n" + PACKAGE_INDEX.replace('":"', '"="'),
      },
      false,
    ],
    [
      "a compiler option in tsconfig.json",
      {
        "tsconfig.json": FILES["tsconfig.json"]!.replace(
          '"strict":true',
          '"strict":true,"noUnusedLocals":true',
        ),
      },
      false,
    ],
  ];
  let previous = first.bytes;
  for (const [name, edit, changes] of seen) {
    write(project, edit);
    const again = await rebuild(name);
    expect(again.served, name).toBe("frontend");
    if (changes) expect(again.bytes.equals(previous), name).toBe(false);
    previous = again.bytes;
  }

  // The same sources at another absolute path.
  const moved = join(options.directory, "moved");
  cpSync(project, moved, { recursive: true });
  rmSync(join(moved, "out"), { recursive: true, force: true });
  expect((await rebuild("another path", moved)).served).toBe("frontend");
  expect((await rebuild("another path, again", moved)).served).not.toBe("frontend");

  // An option and a variable that change the output.
  expect(
    (await rebuild("another optimization level", project, ["--optimization=dev"])).served,
  ).toBe("frontend");
  expect(
    (await rebuild("a variable the frontend's key holds", project, [], { SCRIPTC_ARENAS: "0" }))
      .served,
  ).toBe("frontend");
  // Back to the first configuration: the entry of the last such build.
  expect((await rebuild("the first configuration")).bytes.equals(previous)).toBe(true);
}
