import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { renderPerformanceWarnings } from "../src/diagnostics/dynamic-tier.js";
import { compile } from "../src/index.js";

// Parallel loops (@scriptc/experimental): parallelInto, parallelReduce and
// parallelFor. A call runs its chunks on helper threads only when the
// compiler can show that doing so is not observable; every other call
// compiles to the Node.js loop and reports SC6106.

const repoRoot = join(import.meta.dirname, "../../..");

const header = `
import { parallelFor, parallelInto, parallelReduce } from "@scriptc/experimental";
`;

interface Built {
  ok: boolean;
  codes: string[];
  messages: string[];
  warnings: string[];
  llvm: string;
}

async function build(source: string): Promise<Built> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-parallel-"));
  try {
    await symlink(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, header + source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    const llvm = result.ok ? await readFile(outPath, "utf8") : "";
    return {
      ok: result.ok,
      codes: (result.diagnostics ?? []).map((d) => d.code),
      messages: (result.diagnostics ?? []).map((d) => d.message),
      warnings: (result.ok ? (result.warnings ?? []) : []).map((d) => `${d.code}: ${d.message}`),
      llvm,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The operands of the call to `name` in the emitted module. */
function operands(built: Built, name: string): string[] {
  const line = built.llvm
    .split("\n")
    .find((text) => text.includes(`@${name}(`) && !text.startsWith("declare"));
  expect(line, `no call of ${name} in\n${built.llvm}`).toBeDefined();
  const open = line!.indexOf("@") + name.length + 1;
  return line!.slice(open + 1, line!.lastIndexOf(")")).split(", ");
}

/** The `parallel` flag of a call: 1 when helpers may take its chunks. */
function parallelFlag(built: Built, name: string): string {
  return operands(built, name)[name === "scr_par_for" ? 3 : 4]!;
}

const intoProgram = (body: string, options = "{ grain: 4 }"): string => `
const table = new Float64Array(16);
for (let i = 0; i < table.length; i++) table[i] = i;
const out = new Float64Array(64);
parallelInto(out, (part, start, end) => {
  ${body}
}, ${options});
console.log(out[3]);
`;

test("an accepted body runs its chunks on helper threads", async () => {
  const built = await build(
    intoProgram(
      "for (let i = start; i < end; i++) part[i - start] = table[i % 16]! * Math.sqrt(i);",
    ),
  );
  expect(built.ok).toBe(true);
  expect(built.warnings).toEqual([]);
  expect(parallelFlag(built, "scr_par_into")).toBe("double 0x3FF0000000000000");
  // The typed array the body reads, so the runtime can compare it with the
  // target: `table`, and no other.
  const reads = operands(built, "scr_par_into").slice(6);
  expect(reads).toHaveLength(2);
  expect(reads[0]).toMatch(/^ptr /);
  expect(reads[1]).toBe("i64 1");
});

test("a body that writes a captured typed array stays sequential", async () => {
  const built = await build(
    intoProgram("for (let i = start; i < end; i++) part[i - start] = 1; log[0] = end;").replace(
      "const out = new Float64Array(64);",
      "const log = new Float64Array(4);\nconst out = new Float64Array(64);",
    ),
  );
  expect(built.ok).toBe(true);
  expect(built.warnings).toHaveLength(1);
  expect(built.warnings[0]).toContain("SC6106");
  expect(built.warnings[0]).toContain("a write to an element of a captured typed array (`log[0]`)");
  expect(parallelFlag(built, "scr_par_into")).toBe("double 0x0000000000000000");
});

test("a body that calls something other than Math stays sequential", async () => {
  const random = await build(intoProgram("part[start % 64] = Math.random();"));
  expect(random.warnings[0]).toContain("SC6106");
  expect(random.warnings[0]).toContain("a call (`Math.random`)");
  const logger = await build(
    intoProgram("for (let i = start; i < end; i++) part[i - start] = i;\nconsole.log(end);"),
  );
  expect(logger.warnings[0]).toContain("a call (`console.log`)");
  expect(parallelFlag(logger, "scr_par_into")).toBe("double 0x0000000000000000");
});

test("a body whose Math is the program's own binding stays sequential", async () => {
  // Name AND provenance: a local object named Math has calls with side
  // effects and throws of its own, so its chunks must stay in order.
  const built = await build(
    [
      "const Math = { sqrt: (x: number): number => x + 0.5 };",
      intoProgram("for (let i = start; i < end; i++) part[i - start] = Math.sqrt(i);"),
    ].join("\n"),
  );
  expect(built.ok).toBe(true);
  expect(built.warnings).toHaveLength(1);
  expect(built.warnings[0]).toContain("SC6106");
  expect(built.warnings[0]).toContain("a call (`Math.sqrt`)");
  expect(parallelFlag(built, "scr_par_into")).toBe("double 0x0000000000000000");
});

test("a body that calls Math.hypot stays sequential", async () => {
  // Math.hypot's arguments reach the runtime as one number[], which every
  // call allocates; a helper thread may not allocate.
  const built = await build(
    intoProgram("for (let i = start; i < end; i++) part[i - start] = Math.hypot(i, 1);"),
  );
  expect(built.ok).toBe(true);
  expect(built.warnings).toHaveLength(1);
  expect(built.warnings[0]).toContain("SC6106");
  expect(built.warnings[0]).toContain("a call (`Math.hypot`), which allocates its argument array");
  expect(parallelFlag(built, "scr_par_into")).toBe("double 0x0000000000000000");
});

test("a body that throws stays sequential", async () => {
  const built = await build(intoProgram('if (start === 8) throw new Error("stop");'));
  expect(built.warnings[0]).toContain("SC6106");
  expect(built.warnings[0]).toContain("a construct outside the accepted body");
});

test("a body that holds a typed array in a local stays sequential", async () => {
  const built = await build(
    intoProgram(
      "const t = table;\n  for (let i = start; i < end; i++) part[i - start] = t[i % 16]!;",
    ),
  );
  expect(built.warnings[0]).toContain("a callback local that is not a number (`t`)");
});

test("a callback the call site does not spell out stays sequential", async () => {
  const built = await build(`
const out = new Float64Array(64);
const body = (part: Float64Array, start: number, end: number): void => {
  for (let i = start; i < end; i++) part[i - start] = i;
};
parallelInto(out, body, { grain: 4 });
console.log(out[3]);
`);
  expect(built.warnings[0]).toContain("a callback that is not a plain function expression");
  expect(parallelFlag(built, "scr_par_into")).toBe("double 0x0000000000000000");
});

test("an async callback stays sequential", async () => {
  // An async body's call returns a promise, which an adapter drops, and its
  // spawn wrapper updates the closure's reference count around the call.
  const into = await build(`
const out = new Float64Array(64);
parallelInto(out, async (part, start, end) => {
  for (let i = start; i < end; i++) part[i - start] = i;
}, { grain: 4 });
console.log(out[3]);
`);
  expect(into.ok).toBe(true);
  expect(into.warnings).toHaveLength(1);
  expect(into.warnings[0]).toContain("SC6106");
  expect(into.warnings[0]).toContain("an async callback");
  expect(parallelFlag(into, "scr_par_into")).toBe("double 0x0000000000000000");
});

test("a body in a program that reads stacks stays sequential", async () => {
  // Such a program pushes a source frame onto the one shared exception
  // cell in every function that keeps one; helper threads must not.
  const built = await build(
    intoProgram("for (let i = start; i < end; i++) part[i - start] = table[i % 16]! + i;") +
      'console.log(String(new Error("probe").stack).split("\\n")[0]);\n',
  );
  expect(built.ok).toBe(true);
  expect(built.warnings).toEqual([]);
  expect(parallelFlag(built, "scr_par_into")).toBe("double 0x0000000000000000");
});

test("parallelReduce folds its chunks on helper threads", async () => {
  const built = await build(`
const sum = parallelReduce(1000, 0, (start, end) => {
  let s = 0;
  for (let i = start; i < end; i++) s += i * i;
  return s;
}, (a, b) => a + b, { grain: 64 });
console.log(sum);
`);
  expect(built.ok).toBe(true);
  expect(built.warnings).toEqual([]);
  expect(parallelFlag(built, "scr_par_reduce")).toBe("double 0x3FF0000000000000");
});

test("parallelReduce with a callback that allocates stays sequential", async () => {
  const built = await build(`
const sum = parallelReduce(1000, 0, (start, end) => {
  const parts: number[] = [];
  return parts.length + start + end;
}, (a, b) => a + b, { grain: 64 });
console.log(sum);
`);
  expect(built.warnings[0]).toContain("SC6106");
  expect(parallelFlag(built, "scr_par_reduce")).toBe("double 0x0000000000000000");
});

test("parallelFor runs its chunks one after another for now", async () => {
  const built = await build(`
parallelFor(64, (start, end) => {
  let seen = 0;
  for (let i = start; i < end; i++) seen += i;
}, { grain: 4 });
console.log("done");
`);
  expect(built.ok).toBe(true);
  expect(built.warnings[0]).toContain("parallelFor's chunks are not yet proven disjoint");
  expect(parallelFlag(built, "scr_par_for")).toBe("double 0x0000000000000000");
});

test("an options value the compiler does not read is a build error", async () => {
  const built = await build(`
const out = new Float64Array(64);
const options = { grain: 4 };
parallelInto(out, (part, start, end) => {
  for (let i = start; i < end; i++) part[i - start] = i;
}, options);
console.log(out[3]);
`);
  expect(built.ok).toBe(false);
  expect(built.messages.join("\n")).toContain("an object literal");
});

test("the sequential warning says the call still compiles", () => {
  const rendered = renderPerformanceWarnings([
    {
      code: "SC6106",
      message: "parallelInto runs its chunks one after another: x",
      loc: { file: "a.ts", start: 0, end: 1 },
    },
  ]);
  expect(rendered).toContain(
    "The program compiled. These calls run their chunks one after another.",
  );
});
