import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { nodeFrontendServices } from "./services-node.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const defines = { "process.env.NODE_ENV": "production" };

function resolveBranches(source: string): string | null {
  return nodeFrontendServices().definedBranches(source, "/pkg/index.js", defines);
}

/** The text's statements, one per line, without the empty ones. */
function statements(text: string): string[] {
  return text
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Resolves `source` and checks that Node, with the variables set, prints
 * the same for both texts. */
function expectSameOutput(
  source: string,
  ext = "cjs",
  values: Record<string, string> = defines,
): string {
  const resolved = nodeFrontendServices().definedBranches(source, "/pkg/index.js", values);
  expect(resolved).not.toBeNull();
  const dir = mkdtempSync(join(tmpdir(), "scriptc-define-branches-"));
  dirs.push(dir);
  const outputs = [source, resolved!].map((text, i) => {
    const file = join(dir, `m${i}.${ext}`);
    writeFileSync(file, text);
    const r = spawnSync(process.execPath, [file], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(values).map(([key, value]) => [key.slice("process.env.".length), value]),
        ),
      },
    });
    expect(r.stderr).toBe("");
    return r.stdout;
  });
  expect(outputs[1]).toBe(outputs[0]);
  return resolved!;
}

test("a decided if keeps its taken branch's statements in place", () => {
  const source = `"use strict";
if (process.env.NODE_ENV === "production") {
  console.log("production");
} else {
  console.log("development");
}
if (process.env["NODE_ENV"] !== "production") console.log("not production");
else console.log("still production");
`;
  const resolved = expectSameOutput(source);
  expect(statements(resolved)).toEqual([
    `"use strict"`,
    `console.log("production")`,
    `console.log("still production")`,
  ]);
  expect(resolved.length).toBe(source.length);
  for (const kept of ['console.log("production")', 'console.log("still production")'])
    expect(resolved.indexOf(kept)).toBe(source.indexOf(kept));
});

test("conditions combine with !, &&, ||, truthiness and else-if chains", () => {
  const source = `if (process.env.NODE_ENV === "development") {
  console.log("development");
} else if (!(process.env.NODE_ENV !== "production") || globalThis.unknown) {
  console.log("production");
} else {
  console.log("other");
}
if (process.env.NODE_ENV == "test" && globalThis.unknown) console.log("test");
if (!process.env.NODE_ENV) console.log("unset");
`;
  expect(statements(expectSameOutput(source))).toEqual([`console.log("production")`]);
});

test("a condition can combine several defined variables", () => {
  const source = `if (process.env.NODE_ENV === "production" && process.env.FEATURE === "on") console.log("both");
else console.log("not both");
if (process.env.FEATURE !== "on") console.log("feature off");
`;
  const both = { "process.env.NODE_ENV": "production", "process.env.FEATURE": "on" };
  const resolved = nodeFrontendServices().definedBranches(source, "/pkg/index.js", both)!;
  expect(statements(resolved)).toEqual([`console.log("both")`]);
  expectSameOutput(source, "cjs", both);
});

test("conditions that need evaluation keep their text", () => {
  expect(
    resolveBranches(`if (globalThis.unknown || process.env.NODE_ENV === "production") f();
if (process.env.NODE_ENV === true) f();
if (process.env.OTHER === "production") f();
`),
  ).toBeNull();
  expect(
    resolveBranches(`const process = { env: { NODE_ENV: "x" } };
if (process.env.NODE_ENV === "production") f();
`),
  ).toBeNull();
  // An imported binding named process shadows the global too.
  for (const binding of [
    `import process from "./fake-process.js";`,
    `import * as process from "./fake-process.js";`,
    `import { process } from "./fake-process.js";`,
    `import { fake as process } from "./fake-process.js";`,
  ]) {
    expect(
      nodeFrontendServices().definedBranches(
        `${binding}
if (process.env.NODE_ENV === "production") f();
`,
        "/pkg/index.mjs",
        defines,
      ),
    ).toBeNull();
  }
  expect(
    nodeFrontendServices().definedBranches(
      `import { other } from "./fake-process.js";
if (process.env.NODE_ENV === "production") f();
`,
      "/pkg/index.mjs",
      defines,
    ),
  ).not.toBeNull();
});

test("an untaken branch's var names stay declared", () => {
  const source = `if (process.env.NODE_ENV !== "production") {
  var label = "debug", { a, b: [c] } = { a: 1, b: [2] };
  for (var i = 0; i < 2; i++) {}
  (function () { var inner = 1; })();
  let scoped = 1;
}
console.log(typeof label, typeof a, typeof c, typeof i, typeof inner, typeof scoped);
`;
  expect(statements(expectSameOutput(source))[0]).toBe("var label, a, c, i");
});

test("a taken if's untaken else keeps its var names declared, and the following lines keep their positions", () => {
  const source = `if (process.env.NODE_ENV === "production") console.log("production");
else { var first = 1, second = 2, third = 3; }
console.log(typeof first, typeof second, typeof third);
`;
  const resolved = expectSameOutput(source);
  expect(statements(resolved)).toContain("var first, second, third");
  const last = "console.log(typeof first";
  expect(resolved.indexOf(last)).toBe(source.indexOf(last));
});

test("decided ifs nested in a taken block or a switch case resolve too", () => {
  const source = `if (process.env.NODE_ENV === "production") {
  if (process.env.NODE_ENV !== "production") console.log("nested untaken");
  else console.log("nested taken");
}
switch (1) {
  case 1:
    if (process.env.NODE_ENV === "production") console.log("case taken");
    else console.log("case untaken");
}
`;
  const kept = statements(expectSameOutput(source));
  expect(kept).toContain(`console.log("nested taken")`);
  expect(kept).toContain(`console.log("case taken")`);
  expect(kept.join(" ")).not.toContain("untaken");
});

test("a taken block that declares block-scoped bindings keeps its braces", () => {
  const source = `const log = [];
let x = "outer";
if (process.env.NODE_ENV === "production") {
  let x = "inner";
  log.push(x);
}
{
  if (process.env.NODE_ENV === "production") {
    using r = { [Symbol.dispose]() { log.push("disposed"); } };
    log.push("in block");
  }
  log.push("after if");
}
log.push(x);
console.log(log.join(" "));
`;
  const resolved = expectSameOutput(source, "mjs");
  expect(resolved).toContain(`{
  let x = "inner";`);
  expect(resolved).toContain(`{
    using r`);
});

test("statements without semicolons stay separate", () => {
  const source = `const log = console.log
if (process.env.NODE_ENV === "production") {
  (function () { log("taken") })()
}
const a = log
if (process.env.NODE_ENV !== "production") {
  log("untaken")
}
[1].forEach((x) => a("after", x))
if (process.env.NODE_ENV === "production") a("then")
else a("else")
;(() => a("last"))()
`;
  expectSameOutput(source);
});

test("an if outside a statement list, or whose untaken branch declares a function, keeps its text", () => {
  expect(
    resolveBranches(`for (let n = 0; n < 2; n++) if (process.env.NODE_ENV === "production") f();
label: if (process.env.NODE_ENV !== "production") f();
if (process.env.NODE_ENV !== "production") {
  function debug() {}
}
`),
  ).toBeNull();
});
