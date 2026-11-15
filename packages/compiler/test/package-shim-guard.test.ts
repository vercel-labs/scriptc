/* Every package shim (packages/compiler/shims, registered in
 * src/frontend/package-shims.ts) compiles without a lowering refusal or a
 * runtime fence anywhere in its own files.
 *
 * Shim files suppress TypeScript errors (like library declarations under
 * skipLibCheck), but never lowering diagnostics: a refusal in code the
 * program reaches fails its build, located in the shim, and one in code it
 * does not reach would fail a later program. This test reaches all of it:
 * the analysis lowers the unreached remainder too, so every function body
 * of every shim module is checked, under both type worlds a project can
 * bring:
 *
 * - bundled: no tsconfig, so scriptc's own Node declarations type Node;
 * - configured: a project as a template generates it, with a tsconfig and
 *   an installed @types/node. The project's @types/node only types the
 *   program when a tsconfig is present, and it declares Node's parameters
 *   more loosely than the bundled declarations do (`write(chunk: any)`),
 *   so a shim line can lower differently there. Two releases: the one the
 *   repository itself installs (the Node 24 line), and the one a project
 *   generated today gets (tests/fixtures/hono-starter pins it).
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { analyze } from "../src/index.js";
import { packageShimEntries } from "../src/frontend/package-shims.js";
import type { ScrDiagnostic } from "../src/diagnostics/diagnostic.js";

const repoRoot = join(import.meta.dirname, "../../..");
const shimRoot = join(repoRoot, "packages/compiler/shims");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-shim-guard-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The tsconfig `create-hono` writes for its Node.js template (its JSX
 * and output settings left out: the project has one source file). Vite's
 * and tsx's templates differ in `target` and `module` only, which scriptc
 * sets itself. */
const TEMPLATE_TSCONFIG = {
  compilerOptions: {
    target: "ESNext",
    module: "NodeNext",
    strict: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    types: ["node"],
  },
  exclude: ["node_modules"],
};

type World = "bundled" | "configured" | "configured-latest";

const TYPES_NODE: Record<Exclude<World, "bundled">, string> = {
  configured: join(repoRoot, "node_modules/@types/node"),
  "configured-latest": join(repoRoot, "tests/fixtures/hono-starter/node_modules/@types/node"),
};

/** A project directory for `world` holding `source` as src/main.ts. */
function projectWith(name: string, world: World, source: string): string {
  const dir = join(scratch, `${world}-${name}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  if (world !== "bundled") {
    mkdirSync(join(dir, "node_modules/@types"), { recursive: true });
    symlinkSync(realpathSync(TYPES_NODE[world]), join(dir, "node_modules/@types/node"));
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
    writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(TEMPLATE_TSCONFIG, null, 2)}\n`);
  }
  const main = join(dir, "src/main.ts");
  writeFileSync(main, source);
  return main;
}

function shimFindings(entry: string, world: World): string[] {
  const main = projectWith(
    entry.slice(shimRoot.length + 1).replace(/[/.]/g, "_"),
    world,
    `import ${JSON.stringify(entry)};\nconsole.log("loaded");\n`,
  );
  const { coverage } = analyze(main);
  expect(coverage.preflightFailed, "the shim type-checks for the analysis").toBe(false);
  const all: ScrDiagnostic[] = [
    ...coverage.diagnostics,
    ...(coverage.runtimeFences ?? []),
    ...(coverage.unreached?.diagnostics ?? []),
    ...(coverage.unreached?.runtimeFences ?? []),
  ];
  return all
    .filter((d) => d.loc.file.startsWith(shimRoot))
    .map((d) => `${d.loc.file.slice(shimRoot.length + 1)}: ${d.code} ${d.message}`);
}

describe("package shims compile without refusals", () => {
  const entries = packageShimEntries();
  test("the registry lists its shim modules", () => {
    expect(entries.map((e) => e.slice(shimRoot.length + 1))).toEqual([
      "chalk/v5.ts",
      "fs-extra/index.ts",
      "hono-node-server/v2.ts",
      "hot-shots/v8-unix-dgram.ts",
      "hot-shots/v8.ts",
      "undici/v5.ts",
      "undici/v7.ts",
    ]);
  });
  // The control for the configured world: a type only @types/node declares
  // checks there and not in the bundled world. A configured world that fell
  // back to the bundled declarations would repeat the first world and prove
  // nothing about the shims.
  test("the configured world types Node with the project's @types/node", () => {
    const source =
      'import type { ListenOptions } from "node:net";\n' +
      "const options: ListenOptions = { port: 0 };\nconsole.log(options.port);\n";
    const failed = (world: World): boolean =>
      analyze(projectWith("control", world, source)).coverage.preflightFailed;
    expect(failed("bundled")).toBe(true);
    expect(failed("configured")).toBe(false);
    expect(failed("configured-latest")).toBe(false);
    const major = (world: Exclude<World, "bundled">): number =>
      Number(
        (
          JSON.parse(readFileSync(join(TYPES_NODE[world], "package.json"), "utf8")) as {
            version: string;
          }
        ).version.split(".")[0],
      );
    expect(major("configured-latest")).toBeGreaterThan(major("configured"));
  }, 120_000);
  for (const entry of entries) {
    for (const world of ["bundled", "configured", "configured-latest"] as const) {
      test(`${entry.slice(shimRoot.length + 1)} (${world})`, () => {
        expect(shimFindings(entry, world)).toEqual([]);
      }, 300_000);
    }
  }
});

/* The same difference in a program's own code: under @types/node,
 * `write(chunk: any)` accepts undefined, so `chunk!` keeps its union and
 * the write takes each arm at run time. */
describe("Node calls lower under the project's @types/node", () => {
  test("res.write(chunk!) of an optional chunk", () => {
    const source = [
      'import { createServer } from "node:http";',
      'const chunks: (Uint8Array | undefined)[] = [new TextEncoder().encode("a"), undefined];',
      "createServer((_req, res) => {",
      "  const chunk = chunks.pop();",
      "  res.write(chunk!);",
      "  res.end();",
      "});",
      "",
    ].join("\n");
    for (const world of ["bundled", "configured", "configured-latest"] as const) {
      const { coverage } = analyze(projectWith("write-optional", world, source));
      expect(coverage.preflightFailed, world).toBe(false);
      expect(
        [...coverage.diagnostics, ...(coverage.runtimeFences ?? [])].map(
          (d) => `${d.code} ${d.message}`,
        ),
        world,
      ).toEqual([]);
    }
  }, 120_000);
});
