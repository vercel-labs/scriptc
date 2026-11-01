import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const pack = libnodePack();
function body(): string {
  return `const pending: Promise<void> = Promise.reject(new RangeError("sentinel"));
process.on("unhandledRejection", () => {
  console.log("unhandled");
  setImmediate(() => {
    console.log("attach");
    pending.catch(() => console.log("caught"));
    console.log("after");
    process.nextTick(() => console.log("tick"));
  });
});
process.on("rejectionHandled", () => console.log("handled"));
`;
}

interface LateRejectionCase {
  id: string;
  hosted: boolean;
  source?: string;
  stdout?: string;
  deferredHost?: boolean;
}

const cases: LateRejectionCase[] = [
  {
    id: "native-late-handling",
    hosted: false,
  },
  {
    id: "hosted-late-handling",
    hosted: true,
  },
];

const lifecycleCases = [
  {
    id: "late-listeners-and-work",
    source: `// Module-level storage keeps this array dynamic during native lowering.
const deferred: any[] = [];
const removed = () => console.log("removed");
process.on("rejectionHandled", removed);
process.on("unhandledRejection", (_reason, pending) => {
  console.log("unhandled");
  // Dynamic catch observes at attachment; the typed helper observes at await.
  // Keep attachment between removing and restoring handled listeners.
  deferred.push(pending);
  setImmediate(() => {
    console.log("attach");
    process.off("rejectionHandled", removed);
    deferred[0].catch(() => console.log("caught first"));
    deferred[0].catch(() => console.log("caught second"));
    process.on("rejectionHandled", removed);
    process.once("rejectionHandled", () => {
      console.log("handled");
      process.nextTick(() => console.log("handled tick"));
      queueMicrotask(() => console.log("handled microtask"));
      setImmediate(() => console.log("handled immediate"));
    });
    process.off("rejectionHandled", removed);
    console.log("after");
    process.nextTick(() => console.log("tick"));
  });
});
Promise.reject("sentinel");
`,
    stdout:
      "unhandled\nattach\nafter\ntick\ncaught first\ncaught second\nhandled\nhandled tick\nhandled microtask\nhandled immediate\n",
  },
  {
    id: "late-once-two-promises",
    source: `let reports = 0;
process.once("rejectionHandled", () => console.log("once"));
process.on("rejectionHandled", () => console.log("on"));
process.on("unhandledRejection", (_reason, pending) => {
  console.log("unhandled");
  pending.catch(() => console.log("caught"));
  if (++reports === 2) process.nextTick(() => console.log("tick"));
});
Promise.reject("first");
Promise.reject("second");
`,
    stdout: "unhandled\nunhandled\ntick\ncaught\ncaught\nonce\non\non\n",
  },
  {
    id: "late-reentrant-handling",
    source: `const pending: any[] = [];
process.on("unhandledRejection", (_reason, promise) => {
  console.log("unhandled");
  pending.push(promise);
  if (pending.length === 2) setImmediate(() => {
    console.log("attach");
    pending[0].catch(() => console.log("caught first"));
  });
});
process.on("rejectionHandled", (promise) => {
  if (promise === pending[0]) {
    console.log("handled first");
    pending[1].catch(() => console.log("caught second"));
    queueMicrotask(() => console.log("handled microtask"));
  } else {
    console.log("handled second");
  }
});
Promise.reject("first");
Promise.reject("second");
`,
    stdout:
      "unhandled\nunhandled\nattach\ncaught first\nhandled first\nhandled second\ncaught second\nhandled microtask\n",
  },
  {
    id: "late-recovery-without-jobs",
    source: `let handled = 0;
process.on("uncaughtException", () => console.log("uncaught"));
process.on("rejectionHandled", () => {
  console.log("handled", ++handled);
  if (handled === 1) throw new Error("listener failure");
});
process.on("unhandledRejection", (_reason, pending) => {
  console.log("unhandled");
  pending.catch(() => console.log("caught"));
});
Promise.reject("first");
Promise.reject("second");
`,
    stdout: "unhandled\nunhandled\ncaught\ncaught\nhandled 1\nuncaught\nhandled 2\n",
  },
  {
    id: "late-recovery-with-jobs",
    source: `let handled = 0;
process.on("uncaughtException", () => {
  console.log("uncaught");
  process.nextTick(() => console.log("uncaught tick"));
  queueMicrotask(() => console.log("uncaught microtask"));
});
process.on("rejectionHandled", () => {
  console.log("handled", ++handled);
  if (handled === 1) throw new Error("listener failure");
});
process.on("unhandledRejection", (_reason, pending) => {
  console.log("unhandled");
  pending.catch(() => console.log("caught"));
});
Promise.reject("first");
Promise.reject("second");
`,
    stdout:
      "unhandled\nunhandled\ncaught\ncaught\nhandled 1\nuncaught\nuncaught tick\nuncaught microtask\nhandled 2\n",
  },
  {
    id: "late-listener-throw",
    source: `process.on("uncaughtException", (error) => console.log("uncaught", error.message));
process.on("rejectionHandled", () => {
  console.log("handled");
  throw new Error("listener failure");
});
process.on("unhandledRejection", (_reason, pending) => {
  console.log("unhandled");
  setImmediate(() => {
    console.log("attach");
    try {
      pending.catch(() => console.log("caught"));
    } catch {
      console.log("attach threw");
    }
    console.log("after");
    process.nextTick(() => console.log("tick"));
  });
});
Promise.reject("sentinel");
`,
    stdout: "unhandled\nattach\nafter\ntick\ncaught\nhandled\nuncaught listener failure\n",
  },
];

for (const hosted of [false, true]) {
  for (const fixture of lifecycleCases) {
    cases.push({
      ...fixture,
      id: `${hosted ? "hosted" : "native"}-${fixture.id}`,
      hosted,
      stdout: (hosted ? "island ready\n" : "") + fixture.stdout,
    });
  }
}

cases.push({
  id: "host-starts-with-late-event",
  hosted: true,
  deferredHost: true,
  source: `// Module-level storage keeps this array dynamic during native lowering.
const deferred: any[] = [];
process.on("rejectionHandled", () => console.log("handled"));
process.on("unhandledRejection", (_reason, pending) => {
  console.log("unhandled");
  // Dynamic catch observes before host startup; the typed await observes later.
  deferred.push(pending);
  setImmediate(() => {
    console.log("attach");
    deferred[0].catch(() => console.log("caught"));
    requireModule("checkpoint-host").start();
    console.log("after");
    process.nextTick(() => console.log("tick"));
  });
});
Promise.reject("sentinel");
`,
  stdout: "unhandled\nattach\nisland ready\nafter\ntick\ncaught\nhandled\n",
});

cases.push({
  id: "handled-listener-starts-host-with-io",
  hosted: true,
  deferredHost: true,
  source: `import { stat } from "node:fs";
const pending: any[] = [];
process.on("unhandledRejection", (_reason, promise) => {
  console.log("unhandled");
  pending.push(promise);
  if (pending.length === 2) setImmediate(() => {
    pending[0].catch(() => console.log("caught first"));
  });
});
process.on("rejectionHandled", (promise) => {
  if (promise === pending[0]) {
    console.log("handled first");
    pending[1].catch(() => console.log("caught second"));
    stat(".", (error) => console.log("io", error === null));
    requireModule("checkpoint-host").start();
    process.nextTick(() => console.log("tick"));
    queueMicrotask(() => console.log("microtask"));
  } else {
    console.log("handled second");
  }
});
Promise.reject("first");
Promise.reject("second");
`,
  stdout:
    "unhandled\nunhandled\ncaught first\nhandled first\nisland ready\nhandled second\ntick\ncaught second\nmicrotask\nio true\n",
});

for (const { id, hosted, source, stdout, deferredHost } of cases) {
  test.skipIf(hosted && pack === null)(
    `late rejection events follow queued work (${id})`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "scriptc-late-rejection-handling-"));
      try {
        const files: Record<string, string> = {
          "package.json": JSON.stringify({
            private: true,
            type: "module",
            scriptc: {
              nodeIslands: { auto: false },
              ...(hosted ? { packages: { "checkpoint-host": "node" } } : {}),
            },
          }),
          "main.ts":
            (hosted
              ? deferredHost
                ? 'import { requireModule } from "@scriptc/node";\n'
                : 'import { start } from "checkpoint-host";\nstart();\n'
              : "") + (source ?? body()),
        };
        if (deferredHost) {
          // Keep the Node oracle's explicit bridge entrypoint unchanged.
          for (const name of ["package.json", "index.js", "index.d.ts"]) {
            files[`node_modules/@scriptc/node/${name}`] = readFileSync(
              new URL(`../../packages/node/${name}`, import.meta.url),
              "utf8",
            );
          }
        }
        if (hosted) {
          files["node_modules/checkpoint-host/package.json"] = JSON.stringify({
            name: "checkpoint-host",
            version: "1.0.0",
            main: "index.js",
            types: "index.d.ts",
          });
          files["node_modules/checkpoint-host/index.js"] =
            'exports.start = function start() { console.log("island ready"); };\n';
          files["node_modules/checkpoint-host/index.d.ts"] =
            "export declare function start(): void;\n";
        }
        for (const [name, source] of Object.entries(files)) {
          const path = join(dir, name);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, source);
        }
        const entry = join(dir, "main.ts");
        const expected = await execFileAsync(process.execPath, [entry], {
          encoding: "utf8",
          timeout: 20_000,
        });
        expect(expected.stdout).toBe(
          stdout ??
            (hosted ? "island ready\n" : "") + "unhandled\nattach\nafter\ntick\ncaught\nhandled\n",
        );
        expect(expected.stderr).toBe("");

        const result = await compile(entry, {
          outPath: join(dir, "program"),
          outDir: dir,
          sanitize,
          ...(hosted && pack !== null ? { libnode: pack } : {}),
        });
        if (!result.ok)
          throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
        const actual = await execFileAsync(result.binaryPath, [], {
          encoding: "utf8",
          timeout: 20_000,
        });
        expect(actual.stdout).toBe(expected.stdout);
        // Match the differential harness's sole ASan context-switch warning normalization.
        const stderr = sanitize
          ? actual.stderr.replace(
              /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm,
              "",
            )
          : actual.stderr;
        expect(stderr).toBe(expected.stderr);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    300_000,
  );
}
