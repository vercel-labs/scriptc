import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

async function emitted(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-worker-shared-loop-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const kernel = `
function sumTo(view: Float64Array, n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) total += view[i]!;
  return total;
}
`;

function body(ll: string, name: string): string {
  return new RegExp(`^define internal [^\\n]*@sc_bf_${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(
    ll,
  )![0];
}

/** The instructions of the blocks whose labels start with `prefix`. */
function blocks(fn: string, prefix: string): string {
  return fn
    .split(/\n(?=[\w.$-]+:)/)
    .filter((block) => block.startsWith(prefix))
    .join("\n");
}

test("a worker program's loop over views that may be shared keeps a bounds-proven copy", async () => {
  const ll = await emitted(`
import { Worker, isMainThread } from "node:worker_threads";
${kernel}
if (isMainThread) {
  const view = new Float64Array(new SharedArrayBuffer(64));
  console.log(sumTo(view, 8));
  new Worker(new URL(import.meta.url));
}
`);
  const fn = body(ll, "sumTo");
  // The guard tests the bounds first, then whether the view is shared.
  expect(fn).toMatch(/^bytes\.version\.owned\d*:/m);
  expect(fn).toMatch(/^bytes\.version\.fast\.shared\d*:/m);
  // The shared copy reads with no bounds test. Each copy is a counted loop
  // that polls between blocks, so its read at the counter is a plain load
  // (plainSharedElement in expr-bytes.ts).
  const shared = blocks(fn, "bytes.version.fast.shared");
  expect(shared).not.toMatch(/icmp (ult|uge|ugt) i64 %\w+, %\w+/);
  expect(fn).toMatch(/load double, ptr %\w+/);
  expect(fn).not.toMatch(/load atomic double/);
});

test("a program without workers keeps two copies of the loop", async () => {
  const ll = await emitted(`${kernel}
console.log(sumTo(new Float64Array(8), 8));
`);
  const fn = body(ll, "sumTo");
  expect(fn).toMatch(/^bytes\.version\.fast\d*:/m);
  expect(fn).not.toMatch(/bytes\.version\.fast\.shared/);
  expect(fn).not.toMatch(/bytes\.version\.owned/);
});
