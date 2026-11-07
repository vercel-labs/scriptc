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

/** A one-file program's cp.checkArgs calls (`args:<form>`), the
 * cp.checkShellArgs calls of a launch that joins its list (`list:<form>`)
 * and cp.shellLine calls (`line`), in the order the IR holds them. */
async function checksAndLines(source: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-child-line-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const found: string[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as { kind?: unknown; fn?: unknown; args?: { value?: unknown }[] };
      if (record.kind === "libCall" && record.fn === "cp.checkArgs")
        found.push(`args:${Number(record.args?.[0]?.value)}`);
      if (record.kind === "libCall" && record.fn === "cp.checkShellArgs")
        found.push(`list:${Number(record.args?.[0]?.value)}`);
      if (record.kind === "libCall" && record.fn === "cp.shellLine") found.push("line");
      for (const value of Object.values(node)) visit(value);
    };
    visit(deserializeModule(await readFile(outPath, "utf8")).functions);
    return found;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a shell launch joins its arguments after they are checked and before the environment is", async () => {
  const name = `const name: string = process.argv[2] ?? "echo";\n`;
  // The file and the arguments Node checks are the ones the call names,
  // not the line built from them.
  expect(
    await checksAndLines(`${imports}${name}spawnSync(name, ["a"], { shell: true });
spawnSync("echo", [name], { shell: true, cwd: name });
`),
  ).toEqual(["list:0", "line", "list:0", "line"]);
  // An environment that can be refused is checked after the line: form 3
  // checks no file and no argument.
  expect(
    await checksAndLines(
      `${imports}${name}spawnSync("echo", [name], { shell: true, env: { A: name } });\n`,
    ),
  ).toEqual(["list:0", "line", "args:3"]);
});
