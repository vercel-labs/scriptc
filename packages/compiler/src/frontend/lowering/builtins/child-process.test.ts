import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../../index.js";

/** The `form` argument of every cp.checkArgs call in a one-file program,
 * in the order the IR holds them. */
async function checkForms(source: string): Promise<number[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-child-args-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const forms: number[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as { kind?: unknown; fn?: unknown; args?: { value?: unknown }[] };
      if (record.kind === "libCall" && record.fn === "cp.checkArgs")
        forms.push(Number(record.args?.[0]?.value));
      for (const value of Object.values(node)) visit(value);
    };
    visit(deserializeModule(await readFile(outPath, "utf8")).functions);
    return forms;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const imports = `import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from "node:child_process";\n`;

test("a launch whose checked values are literals without a NUL gets no check", async () => {
  const launches = [
    `spawnSync("echo", ["a", "b"]);`,
    `execFileSync("echo", ["a"]);`,
    `execSync("echo a");`,
    `spawn("echo", ["a"], { stdio: "ignore" });`,
    `execFile("echo", ["a"], () => {});`,
    `exec("echo a", () => {});`,
  ];
  for (const launch of launches) {
    expect(await checkForms(`${imports}${launch}\n`), launch).toEqual([]);
  }
});

test("a launch with a runtime value is checked before it starts", async () => {
  const name = `process.argv[2] ?? "echo"`;
  expect(
    await checkForms(`${imports}
const name: string = ${name};
spawnSync(name, ["a"]);
spawnSync("echo", [name]);
spawnSync("echo", [], { cwd: name });
spawnSync("echo", [], { env: { A: name } });
execFileSync(name, []);
spawn(name, []);
execFile(name, [], () => {});
`),
  ).toEqual([0, 0, 0, 0, 0, 0, 0]);
});

test("the shell launches name Node's command or file", async () => {
  expect(
    await checkForms(`${imports}
const line: string = process.argv[2] ?? "echo a";
execSync(line);
exec(line, () => {});
execFile(line, [], { shell: true }, () => {});
`),
  ).toEqual([1, 1, 2]);
});

test("a literal Node refuses keeps its check", async () => {
  expect(
    await checkForms(`${imports}
spawnSync("a\\u0000b", []);
spawnSync("", []);
spawnSync("echo", ["a\\u0000b"]);
execSync("");
`),
  ).toEqual([0, 0, 0, 1]);
});
