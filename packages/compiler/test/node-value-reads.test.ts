/* What a JavaScript source reads for a Node value no lowering has a value
 * for (src/frontend/lowering/node-values.ts, node-value-reads.ts): Node's own
 * kind of value decides, from a census of the pinned Node. A name Node does
 * not define reads as Node reads it, a function or class is a function value
 * that refuses when it is called, anything else is refused by name where it
 * is read. No read answers a stand-in string. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";
import {
  NODE_GLOBALS,
  NODE_GLOBAL_OBJECT_MEMBERS,
} from "../src/frontend/lowering/builtin-module-members.generated.js";
import {
  nodeGlobalKind,
  nodeGlobalObjectMemberKind,
  nodeModuleMemberKind,
  processMemberNeedsCommonJsMain,
  processMemberNeedsIpc,
} from "../src/frontend/lowering/node-values.js";

let directory: string;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "scriptc-node-value-reads-"));
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Every refusal the program reports, compile-time or deferred to the
 * statement that runs it. */
function refusals(name: string, source: string): string[] {
  const entry = join(directory, name);
  writeFileSync(entry, source);
  const { coverage } = analyze(entry, {});
  return [...coverage.diagnostics, ...(coverage.runtimeFences ?? [])].map(
    (d) => `${d.code}: ${d.message}`,
  );
}

/** The program's IR text. */
async function irOf(name: string, source: string): Promise<string> {
  const entry = join(directory, name);
  writeFileSync(entry, source);
  const out = join(directory, ".scriptc", `${name}.ir.json`);
  const result = await compile(entry, {
    outDir: join(directory, ".scriptc"),
    outPath: out,
    outputKind: "ir",
  });
  expect(result.ok ? [] : result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  return readFileSync(out, "utf8");
}

describe("the census of the pinned Node", () => {
  test("says what a global is, and which names Node does not define", () => {
    expect(nodeGlobalKind("URL")).toEqual({ kind: "function", length: 1 });
    expect(nodeGlobalKind("setTimeout")).toEqual({ kind: "function", length: 2 });
    expect(nodeGlobalKind("process")).toEqual({ kind: "value", type: "object" });
    // Behind a flag in Node 24, another host's, a later ECMAScript edition's.
    for (const name of ["localStorage", "sessionStorage", "window", "Bun", "Temporal"])
      expect(nodeGlobalKind(name), name).toBeNull();
    // Module bindings, not properties of the global object.
    for (const name of ["require", "module", "exports", "__dirname"])
      expect(nodeGlobalKind(name), name).toBeNull();
  });

  test("says what a builtin module member is", () => {
    expect(nodeModuleMemberKind("module", "register")).toEqual({ kind: "function", length: 1 });
    expect(nodeModuleMemberKind("fs", "readFileSync")).toEqual({ kind: "function", length: 2 });
    expect(nodeModuleMemberKind("worker_threads", "SHARE_ENV")).toEqual({
      kind: "value",
      type: "symbol",
    });
    // A function on macOS and undefined elsewhere: recorded as depending on
    // the platform, wherever the census is generated.
    expect(nodeModuleMemberKind("fs", "lchmod")).toEqual({ kind: "value", type: "platform" });
    expect(nodeModuleMemberKind("fs", "noSuchMember")).toBeNull();
    expect(nodeModuleMemberKind("not-a-module", "x")).toBeUndefined();
  });

  test("says what a member of a Node global object is", () => {
    expect(nodeGlobalObjectMemberKind("process", "debugPort")).toEqual({
      kind: "value",
      type: "number",
    });
    expect(nodeGlobalObjectMemberKind("process", "abort")).toEqual({ kind: "function", length: 0 });
    // Inherited members are members.
    expect(nodeGlobalObjectMemberKind("process", "on")?.kind).toBe("function");
    expect(nodeGlobalObjectMemberKind("performance", "timeOrigin")).toEqual({
      kind: "value",
      type: "number",
    });
    expect(nodeGlobalObjectMemberKind("crypto.subtle", "digest")).toEqual({
      kind: "function",
      length: 2,
    });
    expect(nodeGlobalObjectMemberKind("process", "browser")).toBeNull();
    expect(nodeGlobalObjectMemberKind("Math", "max")).toBeUndefined();
  });

  test("knows the process members only some processes have", () => {
    for (const name of ["connected", "channel", "send", "disconnect"])
      expect(processMemberNeedsIpc(name), name).toBe(true);
    expect(processMemberNeedsIpc("pid")).toBe(false);
    expect(processMemberNeedsCommonJsMain("mainModule")).toBe(true);
    // Without a channel and with an ES module entry they are not members.
    expect(nodeGlobalObjectMemberKind("process", "connected")).toBeNull();
    expect(nodeGlobalObjectMemberKind("process", "mainModule")).toBeNull();
  });

  // The census is generated from the repository's pinned Node, so it is
  // compared with the running Node only where that is the pinned release.
  const pinned = readFileSync(new URL("../../../.node-version", import.meta.url), "utf8").trim();
  test.skipIf(process.version !== `v${pinned}`)("matches the running Node", () => {
    const describeValue = (value: unknown): string =>
      typeof value === "function" ? `function=${value.length}` : `value=${typeof value}`;
    const entries = (text: string, kind: string): [string, string][] =>
      text
        .split(" ")
        .filter((entry) => entry !== "")
        .map((entry) => {
          const [name, detail] = entry.split("=");
          return [name!, `${kind}=${detail}`];
        });
    const globals = globalThis as unknown as Record<string, unknown>;
    for (const [name, expected] of [
      ...entries(NODE_GLOBALS.functions, "function"),
      ...entries(NODE_GLOBALS.values, "value"),
    ])
      expect(describeValue(globals[name]), name).toBe(expected);
    expect(
      Object.getOwnPropertyNames(globalThis)
        .filter((name) => nodeGlobalKind(name) === null)
        // Added by the test runner.
        .filter((name) => !name.startsWith("__vi")),
    ).toEqual([]);
    const performanceMembers = NODE_GLOBAL_OBJECT_MEMBERS["performance"]!;
    for (const [name, expected] of entries(performanceMembers.functions, "function"))
      expect(describeValue((performance as unknown as Record<string, unknown>)[name]), name).toBe(
        expected,
      );
  });
});

describe("a JavaScript read of a Node value with no native value", () => {
  test("is never a placeholder string in the program", async () => {
    const ir = await irOf(
      "values.mjs",
      `import { register } from "node:module";
import { AsyncResource } from "node:async_hooks";
import { promisify } from "node:util";
import { lookup } from "node:dns";
const pass = (value) => value;
const tools = { URL, Headers, Request, Response, AbortController, TextEncoder, Event, Blob };
const known = new Set([register, AsyncResource, promisify, lookup, pass(process), pass(performance)]);
const { Console } = console;
const { subtle } = globalThis.crypto;
const { CryptoKey, SubtleCrypto, MessageChannel } = globalThis;
console.log(typeof tools.URL, known.size, typeof Console, typeof subtle, typeof CryptoKey);
console.log(typeof SubtleCrypto, typeof MessageChannel, typeof globalThis.Crypto);
`,
    );
    expect(ir).not.toContain("[builtin ");
  });

  test("reads a function or class without reporting a refusal", () => {
    expect(
      refusals(
        "functions.mjs",
        `import { register } from "node:module";
import { AsyncResource } from "node:async_hooks";
const known = new Set([register, AsyncResource, URL, Headers]);
console.log(known.has(AsyncResource), typeof register, register.name, register.length);
`,
      ),
    ).toEqual([]);
  });

  test("answers what Node answers for a name Node does not define", () => {
    expect(
      refusals(
        "absent.mjs",
        `import * as zlib from "node:zlib";
console.log(typeof localStorage, typeof globalThis.sessionStorage, "localStorage" in globalThis);
if (typeof localStorage !== "undefined") console.log("storage");
console.log(zlib.Z_NO_FLUSH, process.browser, process.connected);
`,
      ),
    ).toEqual([]);
  });

  test("answers the values that are cheap and exact", () => {
    expect(
      refusals(
        "exact.mjs",
        `console.log(process.debugPort, process.sourceMapsEnabled, typeof performance.timeOrigin);
console.log(typeof process.abort, typeof process.finalization);
`,
      ),
    ).toEqual([]);
  });

  test("refuses the read of any other value by name", () => {
    for (const [source, surface] of [
      [`console.log(process.finalization);\n`, "process.finalization"],
      [`import { snapshot } from "node:test";\nconsole.log(snapshot);\n`, "test.snapshot"],
      [
        `import { performance } from "node:perf_hooks";\nconsole.log(performance.nodeTiming);\n`,
        "performance.nodeTiming",
      ],
    ] as const) {
      const found = refusals(`${surface}.mjs`, source);
      expect(found, surface).toHaveLength(1);
      expect(found[0], surface).toContain("SC2020");
      expect(found[0], surface).toContain(`'${surface}'`);
    }
  });

  test("refuses process.mainModule where the entry is CommonJS, and reads undefined in an ES module", () => {
    const found = refusals("main-module.cjs", `console.log(process.mainModule);\n`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("'process.mainModule'");
    expect(refusals("main-module.mjs", `console.log(process.mainModule);\n`)).toEqual([]);
  });

  test("a held process object refuses the members whose value the program can change", async () => {
    // `process.exitCode` is undefined in a fresh Node process and whatever
    // the program assigned afterwards. A value fixed when the object was
    // built would go stale, so the member of the held object is a getter
    // that refuses by name; the spelled `process.exitCode` reads the code.
    const ir = await irOf(
      "held-exit-code.mjs",
      `const pass = (value) => value;\nconst held = pass(process);\nprocess.exitCode = 3;\ntry { console.log(held.exitCode); } catch (error) { console.log(error.code); }\nprocess.exitCode = 0;\n`,
    );
    expect(ir).toContain("'process.exitCode' is a Node value that native code does not provide");
    expect(ir).toContain(
      "'process._maxListeners' is a Node value that native code does not provide",
    );
  });

  test("a held process object refuses a write to a data member", async () => {
    // Node's write reaches the process (`held.exitCode = 4` exits 4). The
    // held object has no state of its own to write, and dropping the write
    // would exit 0, so the setter refuses by name.
    const ir = await irOf(
      "held-write.cjs",
      `const pass = (value) => value;\nconst held = pass(process);\ntry { held.exitCode = 4; } catch (error) { console.log(error.code); }\n`,
    );
    expect(ir).toContain("assigning a member of 'process' through a stored value");
  });

  test("names the member when a function value is called", async () => {
    const ir = await irOf(
      "called.mjs",
      `import { register } from "node:module";\nconst pass = (value) => value;\ntry { pass(register)("./hooks.mjs"); } catch (error) { console.log(error.code); }\n`,
    );
    expect(ir).toContain("'module.register' is a Node value that native code does not provide");
    expect(ir).toContain("SC2020");
  });
});
