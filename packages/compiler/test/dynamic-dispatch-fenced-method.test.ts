import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileModule(name: string, source: string) {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-dispatch-fence-"));
  try {
    const entry = join(dir, name);
    await writeFile(entry, source);
    return await compile(entry, {
      outDir: dir,
      outPath: join(dir, "main.ir"),
      outputKind: "ir",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a dispatch arm takes the type of a fenced method's body", async () => {
  // An untyped module async-overriding a method of its base leaves the
  // override's body a runtime fence: the signature still says async, but
  // the function answers the slot's own type. A dispatch arm over a boxed
  // instance of the override must call what the fence emits — a promise
  // type there fails to match the callee and aborts validation.
  const result = await compileModule(
    "main.mjs",
    `
class Base {
  dispose() {}
}

class Sub extends Base {
  async dispose() {}
}

function disposeOf(value) {
  return value.dispose();
}

function keep(value) {
  return value;
}

console.log(typeof keep(new Sub()), typeof disposeOf);
`,
  );
  expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
});
