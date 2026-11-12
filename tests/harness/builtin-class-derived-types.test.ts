/* A type derived from a built-in class whose values are opaque handles is
 * that class's object (tests/corpus/builtin-class-derived-types.ts pins what
 * matches Node). These programs pin where the declared type says more than
 * the built-in object holds: the read is checked, so the program stops with
 * a TypeError where Node would go on with a value the type does not admit,
 * and a member the derivation adds stores on the built-in object as an own
 * property, as Node stores it. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const dir = mkdtempSync(join(tmpdir(), "scriptc-builtin-class-derived-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(
  name: string,
  source: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const entry = join(dir, `${name}.ts`);
  writeFileSync(entry, source);
  const result = await compile(entry, { outPath: join(dir, name), outDir: dir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return { code: -1, stdout: "", stderr: "" };
  try {
    const { stdout } = await execFileAsync(result.binaryPath);
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const failure = e as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const almanac = `function almanac(): Response {
  return new Response("moon", { status: 201 });
}
`;

test("a required member the derivation adds is checked when it is read from the built-in object", async () => {
  const { code, stderr } = await run(
    "added-required",
    `${almanac}interface Dated extends Response {
  phase: string;
}
const page = almanac() as unknown as Dated;
console.log(page.status);
console.log(page.phase.length);
`,
  );
  expect(code).toBe(1);
  expect(stderr).toContain("TypeError: expected string at $, got undefined");
});

test("a member the derivation adds stores on the built-in object", async () => {
  const { code, stdout, stderr } = await run(
    "added-write",
    `${almanac}type Dated = Response & { phase?: string };
const page: Dated = almanac();
page.phase = "waxing";
console.log(page.phase, Object.hasOwn(page, "phase"), page.status);
`,
  );
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toBe("waxing true 201\n");
});

test("a member declared again at a type the built-in object does not hold is refused when it is read", async () => {
  const { code, stderr } = await run(
    "redeclared-wrong",
    `${almanac}interface Worded extends Omit<Response, "status"> {
  status: string;
}
const page = almanac() as unknown as Worded;
console.log(page.status.length);
`,
  );
  expect(code).toBe(1);
  expect(stderr).toContain("TypeError: expected string at $, got number");
});
