/* The web stream globals a project's own code names while its @types/node
 * predates them (20.11 and earlier declare none; 24.13.3 declares them in
 * web-globals/streams.d.ts). Node's runtime provides the globals whatever
 * the installed declarations say, so a project that names one compiles:
 * the declaration joins the program beside the adopted Node types
 * (program.ts, nodeTypesSupplementRoots7). Before that it stopped at
 * preflight with SC0001 "Cannot find name 'ReadableStream'".
 *
 * The program is compared with Node, byte for byte, like a corpus program. */
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const vendored = join(repoRoot, "tests/fixtures/node-types/node_modules");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const scratch = mkdtempSync(join(tmpdir(), "scriptc-web-stream-globals-"));

/** A project directory whose @types/node declares no web stream globals,
 * which is @types/node 20.11 and earlier: the vendored 24.13.3 keeps them
 * in web-globals/streams.d.ts, so removing the file and its reference
 * leaves every other global in place. */
function projectWithoutWebStreamGlobals(name: string): string {
  const dir = join(scratch, name);
  const types = join(dir, "node_modules/@types/node");
  cpSync(join(vendored, "@types/node"), types, { recursive: true });
  cpSync(join(vendored, "undici-types"), join(dir, "node_modules/undici-types"), {
    recursive: true,
  });
  const reference = '/// <reference path="web-globals/streams.d.ts" />\n';
  const index = readFileSync(join(types, "index.d.ts"), "utf8");
  expect(index).toContain(reference);
  writeFileSync(join(types, "index.d.ts"), index.replace(reference, ""));
  rmSync(join(types, "web-globals/streams.d.ts"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          lib: ["ES2021"],
          module: "commonjs",
          moduleResolution: "node",
          target: "ES2021",
          strict: true,
          typeRoots: ["./node_modules/@types"],
        },
      },
      null,
      2,
    ) + "\n",
  );
  return dir;
}

async function nodeOutput(dir: string): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [join(dir, "main.ts")], {
    cwd: dir,
    encoding: "utf8",
  });
  return stdout;
}

describe("web stream globals beside an older @types/node", () => {
  test("project code naming the globals compiles and matches Node", async () => {
    const dir = projectWithoutWebStreamGlobals("named-in-project-code");
    writeFileSync(
      join(dir, "main.ts"),
      [
        "let body: ReadableStream | null = null;",
        "let sink: WritableStream | null = null;",
        "let pair: TransformStream | null = null;",
        "let reader: ReadableStreamDefaultReader | null = null;",
        "let writer: WritableStreamDefaultWriter | null = null;",
        "let strategy: CountQueuingStrategy | null = null;",
        "console.log(",
        "  body === null,",
        "  sink === null,",
        "  pair === null,",
        "  reader === null,",
        "  writer === null,",
        "  strategy === null",
        ");",
        "",
      ].join("\n"),
    );
    const expected = await nodeOutput(dir);
    expect(expected).toBe("true true true true true true\n");
    const out = join(dir, ".scriptc");
    mkdirSync(out);
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(out, "program"),
      outDir: out,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n"));
    const { stdout } = await execFileAsync(result.binaryPath, [], { cwd: dir, encoding: "utf8" });
    expect(stdout).toBe(expected);
  }, 180_000);
});
