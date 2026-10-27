/* The heap census (backend/llvm/heap-census.ts): a program built with
 * SCRIPTC_HEAP_CENSUS counts class instances and the stores, lengths and
 * accesses of array-typed fields, and writes them at exit, on a normal exit
 * and on process.exit alike. */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const exec = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

const PROGRAM = `
class Node {
  kids: Node[];
  tags: string[] | undefined;
  constructor(kids: Node[]) {
    this.kids = kids;
    if (kids.length > 1) this.tags = ["a", "b"];
    else this.tags = undefined;
  }
}
let total = 0;
const roots: Node[] = [];
for (let i = 0; i < 100; i++) {
  const leaves: Node[] = [];
  for (let j = 0; j < i % 6; j++) leaves.push(new Node([]));
  roots.push(new Node(leaves));
}
for (const r of roots) total += r.kids.length + (r.tags?.length ?? 0);
console.log(total);
`;

async function census(source: string): Promise<{ stdout: string; counts: Map<string, number> }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-heap-census-"));
  const saved = process.env["SCRIPTC_HEAP_CENSUS"];
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    process.env["SCRIPTC_HEAP_CENSUS"] = "1";
    const result = await compile(entry, {
      backend: "llvm",
      sanitize,
      outDir: dir,
      outPath: join(dir, "program"),
    });
    if (saved === undefined) delete process.env["SCRIPTC_HEAP_CENSUS"];
    else process.env["SCRIPTC_HEAP_CENSUS"] = saved;
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) throw new Error("compile failed");
    const out = join(dir, "census.tsv");
    const { stdout } = await exec(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_HEAP_CENSUS: out },
      timeout: 120_000,
    });
    const counts = new Map<string, number>();
    for (const line of (await readFile(out, "utf8")).trimEnd().split("\n")) {
      const [kind, cls, field, count] = line.split("\t");
      counts.set(`${kind} ${cls}${field ? "." + field : ""}`, Number(count));
    }
    return { stdout, counts };
  } finally {
    if (saved === undefined) delete process.env["SCRIPTC_HEAP_CENSUS"];
    else process.env["SCRIPTC_HEAP_CENSUS"] = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

const EXPECTED: [string, number][] = [
  // 100 roots and 246 leaves (i % 6 children each).
  ["new Node", 346],
  ["store Node.kids", 346],
  ["elements Node.kids", 246],
  ["len0 Node.kids", 263],
  ["len1 Node.kids", 17],
  ["len2 Node.kids", 17],
  ["len3-4 Node.kids", 33],
  ["len5-8 Node.kids", 16],
  ["len9-16 Node.kids", 0],
  // Literals count where the store itself writes one.
  ["literal Node.kids", 0],
  ["store Node.tags", 346],
  ["literal Node.tags", 66],
  // An undefined tags field counts as length 0.
  ["len0 Node.tags", 280],
  ["len2 Node.tags", 66],
  ["elements Node.tags", 132],
];

test.skipIf(process.platform !== "linux")(
  "the census counts instances and array field stores at a normal exit",
  async () => {
    const { stdout, counts } = await census(PROGRAM);
    expect(stdout).toBe("378\n");
    for (const [key, count] of EXPECTED) expect([key, counts.get(key)]).toEqual([key, count]);
    // Every store also computes the field's address.
    expect(counts.get("access Node.kids")).toBeGreaterThanOrEqual(346 + 100);
  },
  240_000,
);

test.skipIf(process.platform !== "linux")(
  "the census is written on process.exit too",
  async () => {
    const { stdout, counts } = await census(PROGRAM + "process.exit(0);\n");
    expect(stdout).toBe("378\n");
    expect(counts.get("new Node")).toBe(346);
  },
  240_000,
);
