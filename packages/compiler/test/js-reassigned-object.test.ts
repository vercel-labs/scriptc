import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// Stream.zip stores the next pull in one let, and each write names a
// field the previous object did not have.
const pullJs = `export function pull() {
  let state = { _tag: "Both" };
  const out = [];
  for (let i = 0; i < 3; i++) {
    if (state._tag === "Both") {
      out.push("both");
      state = { _tag: "Left", right: "r" };
    } else if (state._tag === "Left") {
      out.push(state.right);
      state = { _tag: "Right", left: "l" };
    } else {
      out.push(state.left);
      state = { _tag: "Both" };
    }
  }
  return out;
}
`;

const entrySource = `import { pull } from "widgets/pull.js";
console.log(JSON.stringify(pull()));
`;

test("a package JS let keeps fields from later object writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-js-reassign-"));
  const pkg = join(directory, "node_modules", "widgets");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "widgets", version: "0.0.0" }));
  writeFileSync(join(pkg, "pull.js"), pullJs);
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
    expect(run.stdout).toBe('["both","r","l"]\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
