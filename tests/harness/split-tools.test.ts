import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, expect, test } from "vitest";

// The repository root supplies typescript and oxfmt to the split tools.
const root = fileURLToPath(new URL("../..", import.meta.url));
const tool = (name: string): string => join(root, "scripts/split", name);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const compilerOptions = {
  strict: true,
  noEmit: true,
  target: "ES2022",
  module: "ESNext",
  moduleResolution: "Bundler",
};

/** A checkout holding `files` (paths relative to its root) and a tsconfig. */
function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "split-tools-"));
  dirs.push(dir);
  const all = { ...files, "tsconfig.json": JSON.stringify({ compilerOptions }) };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function run(script: string, args: string[], repo: string): void {
  execFileSync(process.execPath, [tool(script), ...args, "--repo", repo, "--tools", root], {
    cwd: repo,
    stdio: "pipe",
  });
}

/** Type errors in the checkout's files. */
function diagnostics(dir: string): string[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(dir, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    },
  );
  const program = ts.createProgram(parsed!.fileNames, parsed!.options);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

test("split-methods keeps an import a staying method uses as a shorthand property", () => {
  const dir = checkout({
    "src/helper.ts": "export const helper = 2;\n",
    "src/host.ts": [
      'import { helper } from "./helper.js";',
      "",
      "export class Host {",
      "  value = 1;",
      "  keep(): { helper: number } {",
      "    return { helper };",
      "  }",
      "  moved(): number {",
      "    return this.value + 1;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "split.json": JSON.stringify({
      module: "src/host.ts",
      class: "Host",
      methods: { "moved.ts": ["moved"] },
    }),
  });
  run("split-methods.mjs", ["apply", join(dir, "split.json")], dir);
  expect(readFileSync(join(dir, "src/host.ts"), "utf8")).toContain(
    'import { helper } from "./helper.js";',
  );
  expect(diagnostics(dir)).toEqual([]);
});

/** An oxfmt.config.ts that records it ran by writing `marker`. */
const recordingConfig = (marker: string): string =>
  [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(marker)}, "ran");`,
    "export default {};",
    "",
  ].join("\n");

test("split-methods formats with the tools checkout's configuration, not the branch's", () => {
  const dir = checkout({
    "src/host.ts": [
      "export class Host {",
      "  value = 1;",
      "  moved(): number {",
      "    return this.value + 1;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "split.json": JSON.stringify({
      module: "src/host.ts",
      class: "Host",
      methods: { "moved.ts": ["moved"] },
    }),
  });
  const markers = [join(dir, "root-config-ran"), join(dir, "nested-config-ran")];
  writeFileSync(join(dir, "oxfmt.config.ts"), recordingConfig(markers[0]!));
  writeFileSync(join(dir, "src/oxfmt.config.ts"), recordingConfig(markers[1]!));
  run("split-methods.mjs", ["apply", join(dir, "split.json")], dir);
  expect(readFileSync(join(dir, "src/moved.ts"), "utf8")).toContain("export function moved");
  for (const marker of markers) expect(existsSync(marker)).toBe(false);
});

test("move-state formats with the tools checkout's configuration, not the branch's", () => {
  const dir = checkout({
    "src/host.ts":
      "export class Host {\n  count = 0;\n  moved(): number {\n    return this.count + 1;\n  }\n}\n",
    "state.template": "",
    "split.json": JSON.stringify({
      module: "src/host.ts",
      class: "Host",
      dir: "src",
      create: { "host-state.ts": "state.template" },
      groups: [
        { file: "host-state.ts", key: "COUNTS", interfaceName: "Counts", fields: ["count"] },
      ],
    }),
  });
  const markers = [join(dir, "root-config-ran"), join(dir, "nested-config-ran")];
  writeFileSync(join(dir, "oxfmt.config.ts"), recordingConfig(markers[0]!));
  writeFileSync(join(dir, "src/oxfmt.config.ts"), recordingConfig(markers[1]!));
  run("move-state.mjs", ["apply", join(dir, "split.json")], dir);
  expect(readFileSync(join(dir, "src/host.ts"), "utf8")).toContain("COUNTS.of(this).count");
  for (const marker of markers) expect(existsSync(marker)).toBe(false);
});

test("split-module imports a moved class's local base class as a value", () => {
  const dir = checkout({
    "src/shapes.ts": [
      "export class Base {",
      "  x = 1;",
      "}",
      "",
      "export class Derived extends Base {",
      "  y = 2;",
      "}",
      "",
      "export function base(): Base {",
      "  return new Base();",
      "}",
      "",
    ].join("\n"),
    "split.json": JSON.stringify({
      tsconfig: "tsconfig.json",
      module: "src/shapes.ts",
      seeds: { "derived.ts": ["Derived"] },
      manifest: "manifest.json",
    }),
  });
  const config = join(dir, "split.json");
  run("split-module.mjs", ["plan", config], dir);
  run("split-module.mjs", ["apply", config], dir);
  expect(readFileSync(join(dir, "src/derived.ts"), "utf8")).toContain(
    'import { Base } from "./shapes.js";',
  );
  expect(diagnostics(dir)).toEqual([]);
});

/* A copy of tests/fixtures/split-tools/symlink: `repo/` is the checkout the
 * tools rewrite, and its committed `src/linked.ts` links to `outside/linked.ts`
 * next to it. */
const symlinkFixture = fileURLToPath(new URL("../fixtures/split-tools/symlink", import.meta.url));
const outsideText = readFileSync(join(symlinkFixture, "outside/linked.ts"), "utf8");

function symlinkCheckout(): { dir: string; repo: string } {
  const dir = mkdtempSync(join(tmpdir(), "split-tools-"));
  dirs.push(dir);
  cpSync(symlinkFixture, dir, { recursive: true, verbatimSymlinks: true });
  return { dir, repo: join(dir, "repo") };
}

/** Runs a tool that must refuse; answers its stderr. */
function refused(script: string, config: object, dir: string, repo: string): string {
  const path = join(dir, "split.json");
  writeFileSync(path, JSON.stringify(config));
  const result = spawnSync(
    process.execPath,
    [tool(script), "apply", path, "--repo", repo, "--tools", root],
    { cwd: repo, encoding: "utf8" },
  );
  expect(result.status).not.toBe(0);
  return result.stderr;
}

test("split-methods refuses to write a new file through a symlink that leaves the checkout", () => {
  const { dir, repo } = symlinkCheckout();
  // A link to a file that doesn't exist yet: writing through it would create the file.
  symlinkSync("../../outside/created.ts", join(repo, "src/moved.ts"));
  const stderr = refused(
    "split-methods.mjs",
    { module: "src/host.ts", class: "Host", methods: { "moved.ts": ["moved"] } },
    dir,
    repo,
  );
  expect(stderr).toContain("refusing");
  expect(existsSync(join(dir, "outside/created.ts"))).toBe(false);
});

test("split-methods refuses a module that links outside the checkout", () => {
  const { dir, repo } = symlinkCheckout();
  const stderr = refused(
    "split-methods.mjs",
    { module: "src/linked.ts", class: "Host", methods: { "moved.ts": ["moved"] } },
    dir,
    repo,
  );
  expect(stderr).toContain("refusing");
});

test("split-module refuses a module that links outside the checkout", () => {
  const { dir, repo } = symlinkCheckout();
  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions }));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ "moved.ts": ["outside"] }));
  const stderr = refused(
    "split-module.mjs",
    { tsconfig: "tsconfig.json", module: "src/linked.ts", manifest: "manifest.json" },
    dir,
    repo,
  );
  expect(stderr).toContain("refusing");
});

test("move-state refuses a state file that a branch commits as a link outside the checkout", () => {
  const { dir, repo } = symlinkCheckout();
  // The group file is listed under `create` and already exists as a link, so
  // creation skips it and the move would append the state through the link.
  symlinkSync("../../outside/linked.ts", join(repo, "src/host-state.ts"));
  writeFileSync(join(dir, "state.template"), "");
  const stderr = refused(
    "move-state.mjs",
    {
      module: "src/host.ts",
      class: "Host",
      dir: "src",
      create: { "host-state.ts": "state.template" },
      groups: [
        { file: "host-state.ts", key: "COUNTS", interfaceName: "Counts", fields: ["count"] },
      ],
    },
    dir,
    repo,
  );
  expect(stderr).toContain("refusing");
  expect(readFileSync(join(dir, "outside/linked.ts"), "utf8")).toBe(outsideText);
});

test("move-state refuses to rewrite a file that links outside the checkout", () => {
  const { dir, repo } = symlinkCheckout();
  writeFileSync(join(repo, "src/host-state.ts"), "");
  const stderr = refused(
    "move-state.mjs",
    {
      module: "src/host.ts",
      class: "Host",
      dir: "src",
      groups: [
        { file: "host-state.ts", key: "COUNTS", interfaceName: "Counts", fields: ["count"] },
      ],
      replacements: [{ file: "linked.ts", find: "export const outside = 1;", replace: "" }],
    },
    dir,
    repo,
  );
  expect(stderr).toContain("refusing");
  expect(readFileSync(join(dir, "outside/linked.ts"), "utf8")).toBe(outsideText);
});
