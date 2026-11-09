import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// getColorDepth and hasColors of a process stream: the calls whose refusal
// waits for the call to run are named by the build where it can see them,
// and an assertion over the optional call's answer is refused.
async function build(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-terminal-colors-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    const result = await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
    return {
      errors: result.ok ? [] : result.diagnostics.map((d) => `${d.code}: ${d.message}`),
      throwing: (result.ok ? (result.warnings ?? []) : [])
        .filter((d) => d.code === "SC6015")
        .map((d) => `${source.slice(d.loc.start, d.loc.end)}: ${d.message}`),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const throws = (refusal: string): string =>
  `this statement throws when it runs (SC2020: Native process stream ${refusal} has no lowering), where it would have completed under Node; a program that never reaches it runs as it does under Node`;

test("an environment that is no plain object is named at the call", async () => {
  const result = await build(`console.log(process.stdout.getColorDepth(["xterm"]));
console.log(process.stdout.getColorDepth(new Map([["TERM", "xterm"]])));
console.log(process.stderr.hasColors(16, ["xterm"]));
`);
  expect(result.errors).toEqual([]);
  expect(result.throwing).toEqual([
    `process.stdout.getColorDepth(["xterm"]): ${throws("getColorDepth with an environment that is not a plain object")}`,
    `process.stdout.getColorDepth(new Map([["TERM", "xterm"]])): ${throws("getColorDepth with an environment that is not a plain object")}`,
    `process.stderr.hasColors(16, ["xterm"]): ${throws("hasColors with an environment that is not a plain object")}`,
  ]);
});

test("a literal TERM that names a member of Object.prototype is named at the call", async () => {
  const result = await build(`console.log(process.stdout.getColorDepth({ TERM: "constructor" }));
console.log(process.stdout.getColorDepth({ TERM: "__proto__" }));
console.log(process.stdout.getColorDepth({ TERM: "valueOf" }));
`);
  expect(result.errors).toEqual([]);
  expect(result.throwing).toEqual([
    `process.stdout.getColorDepth({ TERM: "constructor" }): ${throws("getColorDepth for a TERM that names a member of Object.prototype")}`,
    `process.stdout.getColorDepth({ TERM: "__proto__" }): ${throws("getColorDepth for a TERM that names a member of Object.prototype")}`,
  ]);
});

test("the environments the runtime reads are not named", async () => {
  const result = await build(`function depth(env: object): number {
  return process.stdout.getColorDepth(env);
}
console.log(depth({ TERM: "xterm" }), process.stdout.getColorDepth(), process.stdout.getColorDepth({ TERM: "linux" }));
console.log(process.stderr.hasColors(256), process.stderr.hasColors({ COLORTERM: "truecolor" }), process.stdout.getColorDepth?.() ?? 1);
`);
  expect(result.errors).toEqual([]);
  expect(result.throwing).toEqual([]);
});

test("an assertion that the optional call answered is refused", async () => {
  for (const asserted of [
    `process.stdout.getColorDepth?.({ TERM: "xterm" }) as number`,
    `process.stdout.getColorDepth?.()!`,
    `(process.stderr.hasColors?.(256)) as boolean`,
  ]) {
    const result = await build(`const answer = ${asserted};\nconsole.log(typeof answer);\n`);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(
      /^SC2020: 'an asserted answer of WritableStream\.(getColorDepth|hasColors)\?\.\(\)' /,
    );
  }
});

test("an assertion that keeps undefined asserts nothing and builds", async () => {
  const result = await build(`const answer = process.stdout.getColorDepth?.() as number | undefined;
console.log(typeof answer);
`);
  expect(result.errors).toEqual([]);
});
