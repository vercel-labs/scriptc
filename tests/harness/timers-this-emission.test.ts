/* Timer `this` binding emission (behavior is in the differential corpus,
 * timers-callback-this): a callback that may read `this` is wrapped by
 * scr_timer_this_callback, an arrow or a function that never reads `this` is
 * not, and an identifier is classified by the initializer of its `const`
 * binding. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

/** Compiles the program and counts the callbacks wrapped for the timer's
 * `this`. */
async function timerThisWrappers(name: string, source: string): Promise<number> {
  const key = createHash("sha256")
    .update(name)
    .update("\0")
    .update(source)
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `timers-this-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.cjs`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    backend: "llvm",
    outputKind: "llvm",
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  const llvm = readFileSync(result.artifact.path, "utf8");
  return (llvm.match(/call ptr @scr_timer_this_callback\(/g) ?? []).length;
}

test("a callback that never reads this keeps the plain timer", async () => {
  const wrappers = await timerThisWrappers(
    "unbound",
    `'use strict';
const arrow = () => {};
const quiet = function () {
  return 1;
};
function quietDeclaration() {
  return 2;
}
setTimeout(arrow, 1);
setTimeout(quiet, 2);
setTimeout(quietDeclaration, 3);
setTimeout(() => 4, 4);
`,
  );
  expect(wrappers).toBe(0);
});

test("a callback that reads this is bound through a const binding", async () => {
  const wrappers = await timerThisWrappers(
    "bound",
    `'use strict';
const forward = function () {
  return this;
};
const parameter = function (x = this) {
  return x;
};
setTimeout(forward, 1);
setTimeout(parameter, 2);
setTimeout(function () {
  return this;
}, 3);
`,
  );
  expect(wrappers).toBe(3);
});
