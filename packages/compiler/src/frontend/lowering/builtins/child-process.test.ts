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

/** The checks a one-file program's launches carry, in the order the IR
 * holds them: `args:<form>` for cp.checkArgs, `limit` for a cp.maxBuffer
 * that only validates and `arm` for one that sets the next capture's
 * limit. */
async function checks(source: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-child-checks-"));
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
      if (record.kind === "libCall" && record.fn === "cp.maxBuffer")
        found.push(record.args?.[1]?.value === true ? "arm" : "limit");
      for (const value of Object.values(node)) visit(value);
    };
    visit(deserializeModule(await readFile(outPath, "utf8")).functions);
    return found;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const runtimeValues = `const name: string = process.argv[2] ?? "echo";
const limit: number = Number(process.argv[3] ?? "16");
`;

test("a capture's maxBuffer is armed after the launch's values are checked", async () => {
  // spawnSync checks the values, then the limit: one call does both.
  expect(
    await checks(`${imports}${runtimeValues}execFileSync(name, [], { maxBuffer: limit });
execSync(name, { cwd: name, maxBuffer: limit });
`),
  ).toEqual(["args:0", "arm", "args:1", "arm"]);
  // Nothing to check: the limit alone.
  expect(
    await checks(`${imports}${runtimeValues}execSync("echo a", { maxBuffer: limit });
execFile("echo", ["a"], { maxBuffer: 16 }, () => {});
`),
  ).toEqual(["arm", "arm"]);
  // A literal limit in range cannot be refused, so it has no place in the order.
  expect(
    await checks(`${imports}${runtimeValues}execFile(name, [], { maxBuffer: 16 }, () => {});
exec(name, { cwd: name, maxBuffer: 16 }, () => {});
`),
  ).toEqual(["args:0", "arm", "args:1", "arm"]);
});

test("execFile validates the limit before spawn checks the values, exec after its command", async () => {
  expect(
    await checks(`${imports}${runtimeValues}execFile(name, [], { maxBuffer: limit }, () => {});
execFile(name, [], { shell: true, maxBuffer: limit }, () => {});
`),
  ).toEqual(["limit", "args:0", "arm", "limit", "args:2", "arm"]);
  expect(
    await checks(`${imports}${runtimeValues}exec(name, { maxBuffer: limit }, () => {});
exec(name, { cwd: name, maxBuffer: limit }, () => {});
exec("echo a", { cwd: name, maxBuffer: limit }, () => {});
`),
  ).toEqual([
    ...["args:1", "limit", "arm"],
    // The command, the limit, then the options: form 3 checks no file.
    ...["args:1", "limit", "args:3", "arm"],
    ...["limit", "args:3", "arm"],
  ]);
});
