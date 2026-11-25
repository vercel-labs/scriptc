/* A hand-written type predicate or assertion function is a claim TypeScript
 * does not check. When it lies, the narrowing guard stops the program with
 * its trap message instead of reading the payload as the claimed type (which
 * crashed before the guards existed). Node throws or reads `undefined`
 * there, so these programs intentionally diverge and are not corpus cases. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const UNION_TRAP =
  "scriptc: a narrowed value does not have the type its narrowing proved " +
  "(a type predicate or assertion may be wrong)\n";

async function run(source: string): Promise<ReturnType<typeof spawnSync>> {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-narrow-traps-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const built = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!built.ok) throw new Error(built.diagnostics.map((d) => d.message).join("\n"));
    return spawnSync(built.binaryPath, [], { timeout: 30_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")(
  "a lying type predicate stops at the narrowing guard",
  async () => {
    const result = await run(`
function isText(x: string | number): x is string {
  return x !== "";
}
function shout(v: string | number): string {
  if (isText(v)) return v.toUpperCase();
  return "other";
}
const inputs: (string | number)[] = ["a", 42];
for (const v of inputs) console.log(shout(v));
`);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBe("SIGABRT");
    expect(result.stdout.toString()).toBe("A\n");
    expect(result.stderr.toString()).toBe(UNION_TRAP);
  },
);

test.skipIf(process.platform === "win32")(
  "a lying assertion function stops at the narrowing guard",
  async () => {
    const result = await run(`
function assertText(x: string | number): asserts x is string {}
function width(v: string | number): number {
  assertText(v);
  return v.length;
}
const inputs: (string | number)[] = ["abc", 7];
for (const v of inputs) console.log(width(v));
`);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBe("SIGABRT");
    expect(result.stdout.toString()).toBe("3\n");
    expect(result.stderr.toString()).toBe(UNION_TRAP);
  },
);

test.skipIf(process.platform === "win32")(
  "a lying filter predicate throws the checked-extraction TypeError",
  async () => {
    const result = await run(`
interface Cat {
  kind: "cat";
  meows: number;
}
interface Dog {
  kind: "dog";
}
type Pet = Cat | Dog;
const pets: Pet[] = [{ kind: "cat", meows: 2 }, { kind: "dog" }];
const alwaysCat = (p: Pet): p is Cat => p !== undefined;
try {
  console.log("kept", pets.filter(alwaysCat).length);
} catch (e) {
  console.log("caught", (e as Error).name);
}
`);
    expect(result.error).toBeUndefined();
    // Node keeps the Dog and reports 2; the checked projection throws on it.
    expect(result.stdout.toString()).toBe("caught TypeError\n");
  },
);

test.skipIf(process.platform === "win32")(
  "a cast read of a lying predicate's arm throws a catchable TypeError",
  async () => {
    // A cast wrapper carries a type of its own (`{ x?: unknown }`), no arm
    // of the slot. The identifier still proves one arm, so the read
    // extracts that arm: the matching value reads, every other arm — and
    // an absent element — throws a TypeError the program can catch.
    const result = await run(`
interface A { kind: "a"; x: number }
interface B { kind: "b"; y: number }
interface C { kind: "c"; z: number }
function isA(entry: A | B | C): entry is A {
  return true;
}
function readX(all: (A | B | C)[], index: number): string {
  const entry = all[index];
  if (!isA(entry)) return "no";
  return String((entry as { x?: unknown }).x);
}
const values: (A | B | C)[] = [{ kind: "a", x: 1 }, { kind: "b", y: 2 }];
for (let index = 0; index < 2; index++) {
  try {
    console.log(index, readX(values, index));
  } catch (error) {
    console.log(index, error instanceof TypeError);
  }
}
`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe("0 1\n1 true\n");
  },
);
