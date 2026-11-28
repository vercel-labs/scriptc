/* The declaration projection's iteration markers: a loop over a
 * package-produced iterable whose declared element type is pure data is
 * rewritten to the generated marker, and a package without declarations is
 * never projected (the zero-cost rule). */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../index.js";

const execFileAsync = promisify(execFile);

/** Writes a project into a fresh temp dir: `pkg` files and `main.ts`. */
function project(pkg: { types?: string; js: string }, main: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-decl-iter-"));
  const module = join(dir, "node_modules", "sdk-pkg");
  mkdirSync(module, { recursive: true });
  writeFileSync(
    join(module, "package.json"),
    JSON.stringify({ name: "sdk-pkg", version: "1.0.0", main: "index.js", types: "index.d.ts" }),
  );
  writeFileSync(join(module, "index.js"), pkg.js);
  if (pkg.types !== undefined) writeFileSync(join(module, "index.d.ts"), pkg.types);
  writeFileSync(join(dir, "main.ts"), main);
  return dir;
}

/** compile() with the projection's plan captured from stderr. */
async function compileCapturingPlan(
  entry: string,
  outDir: string,
  extra: { npmStatic?: readonly string[] } = {},
) {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const previous = process.env["SCRIPTC_DEBUG_DECL_BOUNDARY"];
  process.env["SCRIPTC_DEBUG_DECL_BOUNDARY"] = "1";
  try {
    const result = await compile(entry, {
      outPath: join(outDir, "main"),
      outDir,
      ...extra,
    });
    return { result, plan: chunks.join("") };
  } finally {
    process.stderr.write = original;
    if (previous === undefined) delete process.env["SCRIPTC_DEBUG_DECL_BOUNDARY"];
    else process.env["SCRIPTC_DEBUG_DECL_BOUNDARY"] = previous;
  }
}

const ITEMS_TYPES =
  "export declare const items: { name: string; count: number }[];\n" +
  "export declare function label(): string;\n";
const ITEMS_JS =
  'export const items = [{ name: "a", count: "1" }, { name: "b", count: "2" }];\n' +
  'export function label() { return "sdk"; }\n';

test(
  "a loop over a package array is projected onto its declared element type",
  { timeout: 600_000 },
  async () => {
    const dir = project(
      { types: ITEMS_TYPES, js: ITEMS_JS },
      'import { items, label } from "sdk-pkg";\nfor (const item of items) console.log(item.name, label());\n',
    );
    const { result, plan } = await compileCapturingPlan(join(dir, "main.ts"), dir);
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(plan).toContain("iterate items as __scriptc_decl_");
    expect(plan).toContain("declare function __scriptc_iter_0(");
    expect(plan).toContain("): Iterable<__scriptc_decl_0>;");
    const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    expect(stdout).toBe("a sdk\nb sdk\n");
  },
);

test(
  "an async generator loop is projected and runs identically",
  { timeout: 600_000 },
  async () => {
    const dir = project(
      {
        types:
          'export type PollItem = { _tag: "Timeout"; newInterval: number } | { _tag: "SlowDown"; newInterval: number };\n' +
          "export declare function poll(): AsyncGenerator<PollItem, void, void>;\n",
        js:
          "export async function* poll() {\n" +
          '  yield { _tag: "Timeout", newInterval: 1000 };\n' +
          '  yield { _tag: "SlowDown", newInterval: 2000 };\n' +
          "}\n",
      },
      'import { poll } from "sdk-pkg";\n' +
        "async function main() {\n" +
        "  for await (const event of poll()) console.log(`${event._tag}:${event.newInterval}`);\n" +
        "}\n" +
        "main();\n",
    );
    const { result, plan } = await compileCapturingPlan(join(dir, "main.ts"), dir);
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(plan).toContain("iterate poll() as __scriptc_decl_");
    expect(plan).toContain("): AsyncIterable<__scriptc_decl_0>;");
    const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    expect(stdout).toBe("Timeout:1000\nSlowDown:2000\n");
  },
);

test(
  "a package without declarations is never projected (zero cost)",
  { timeout: 600_000 },
  async () => {
    const dir = project(
      { js: ITEMS_JS },
      'import { items, label } from "sdk-pkg";\nfor (const item of items) console.log(item.name, label());\n',
    );
    const { result, plan } = await compileCapturingPlan(join(dir, "main.ts"), dir, {
      npmStatic: ["sdk-pkg"],
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    // No projector for the package: the layout is the one without the
    // change (no marker, no generated declaration file).
    expect(plan).not.toContain("iterate");
    expect(plan).not.toContain("__scriptc_iter_");
  },
);

test(
  "non-data element arms (a class member and a method member) are projected",
  { timeout: 600_000 },
  async () => {
    const dir = project(
      {
        types:
          "export type PollItem =\n" +
          '  | { _tag: "Timeout"; newInterval: number }\n' +
          '  | { _tag: "Error"; error: Error }\n' +
          '  | { _tag: "Response"; response: { text(): Promise<string> } };\n' +
          "export declare function poll(): AsyncGenerator<PollItem, void, void>;\n",
        js:
          "export async function* poll() {\n" +
          '  yield { _tag: "Timeout", newInterval: 1000 };\n' +
          '  yield { _tag: "Error", error: new Error("boom") };\n' +
          '  yield { _tag: "Response", response: { text: async () => "body" } };\n' +
          "}\n",
      },
      'import { poll } from "sdk-pkg";\n' +
        "async function main() {\n" +
        "  for await (const event of poll()) {\n" +
        "    switch (event._tag) {\n" +
        '      case "Timeout":\n' +
        "        console.log(1000 / event.newInterval);\n" +
        "        break;\n" +
        '      case "Error":\n' +
        "        console.log(event.error.message);\n" +
        "        break;\n" +
        '      case "Response":\n' +
        "        console.log(await event.response.text());\n" +
        "        break;\n" +
        "    }\n" +
        "  }\n" +
        "}\n" +
        "main();\n",
    );
    const { result, plan } = await compileCapturingPlan(join(dir, "main.ts"), dir);
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(plan).toContain("iterate poll() as __scriptc_decl_");
    const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    expect(stdout).toBe("1\nboom\nbody\n");
  },
);

test(
  "a lying element fails the per-element check instead of passing through",
  { timeout: 600_000 },
  async () => {
    const dir = project(
      {
        types:
          "export type Item =\n" +
          '  | { _tag: "Error"; error: Error }\n' +
          '  | { _tag: "Response"; response: { text(): Promise<string> } };\n' +
          "export declare function poll(): AsyncGenerator<Item, void, void>;\n",
        js:
          "export async function* poll() {\n" +
          '  yield { _tag: "Error", error: JSON.parse(\'"nope"\') };\n' +
          "}\n",
      },
      'import { poll } from "sdk-pkg";\n' +
        "async function main() {\n" +
        "  try {\n" +
        "    for await (const event of poll()) {\n" +
        '      if (event._tag === "Error") console.log(event.error.message);\n' +
        "    }\n" +
        "  } catch (error) {\n" +
        "    console.log((error as Error).name, (error as Error).message);\n" +
        "  }\n" +
        "}\n" +
        "main();\n",
    );
    const { result } = await compileCapturingPlan(join(dir, "main.ts"), dir);
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    console.log("NEG OUT:", JSON.stringify(stdout));
    expect(stdout).toContain("TypeError");
  },
);

test(
  "a package type merely named Error is not the global Error",
  { timeout: 600_000 },
  async () => {
    const dir = project(
      {
        types:
          "export interface Error { code: number }\n" +
          'export type PollItem = { _tag: "Error"; error: Error };\n' +
          "export declare function poll(): AsyncGenerator<PollItem, void, void>;\n",
        js:
          "export async function* poll() {\n" +
          '  yield { _tag: "Error", error: { code: "7" } };\n' +
          "}\n",
      },
      'import { poll } from "sdk-pkg";\n' +
        "async function main() {\n" +
        "  for await (const event of poll()) {\n" +
        '    if (event._tag === "Error") console.log(event.error.code / 2);\n' +
        "  }\n" +
        "}\n" +
        "main();\n",
    );
    const { result, plan } = await compileCapturingPlan(join(dir, "main.ts"), dir);
    // The package interface is not the global Error: naming it as one would
    // check instanceof the global class at run time. The element type must
    // stay unprojected (the site then refuses by name).
    expect(plan).not.toContain("error: Error");
    expect(plan).not.toContain("iterate poll()");
    if (result.ok) throw new Error("compiled; the package Error was treated as the global one");
    expect(result.diagnostics.map((d) => d.code)).toContain("SC1043");
  },
);

test(
  "a quoted method name prints quoted in the boundary declaration",
  { timeout: 600_000 },
  async () => {
    const dir = project(
      {
        types:
          'export type Item = { _tag: "R"; "read-text"(): string };\n' +
          "export declare function poll(): AsyncGenerator<Item, void, void>;\n",
        js:
          "export async function* poll() {\n" +
          '  yield { _tag: "R", "read-text": () => "hi" };\n' +
          "}\n",
      },
      'import { poll } from "sdk-pkg";\n' +
        "async function main() {\n" +
        "  for await (const event of poll()) {\n" +
        '    if (event._tag === "R") console.log(event["read-text"]());\n' +
        "  }\n" +
        "}\n" +
        "main();\n",
    );
    const { result, plan } = await compileCapturingPlan(join(dir, "main.ts"), dir);
    // A quoted member name must stay quoted in the generated declaration or
    // it is not valid TypeScript.
    expect(plan).toContain('"read-text"(): string');
    expect(plan).not.toContain("read-text(): string;");
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    expect(stdout).toBe("hi\n");
  },
);
