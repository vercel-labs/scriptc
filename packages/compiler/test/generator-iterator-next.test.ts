import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Effect's Stream.concat walks a generator (`function* concatChannels`)
// through Channel.fromIterator. The package function is untyped, so the
// checker types the iterator local as `any` even though the call site
// passed a Generator.
const collectJs = `export function collect(iterator) {
  const iter = iterator();
  const out = [];
  while (true) {
    const state = iter.next();
    if (state.done) return out;
    out.push(state.value);
  }
}
`;

const entrySource = `import { collect } from "widgets/collect.js";
function* values(): Generator<number, void, unknown> {
  yield 1;
  yield 2;
  yield 3;
}
console.log(JSON.stringify(collect(() => values())));
`;

test("package JS resumes a generator local with next()", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-gen-next-"));
  const pkg = join(directory, "node_modules", "widgets");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "widgets", version: "0.0.0" }));
  writeFileSync(join(pkg, "collect.js"), collectJs);
  const entry = join(directory, "main.ts");
  const binary = join(directory, "main");
  writeFileSync(entry, entrySource);
  try {
    const result = await compile(entry, {
      outDir: directory,
      outPath: binary,
      outputKind: "exe",
      optimization: "dev",
      npmStatic: ["widgets"],
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    const oracle = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 30_000 });
    expect(oracle.status, oracle.stderr).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(oracle.stdout);
    expect(run.stdout).toBe("[1,2,3]\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
