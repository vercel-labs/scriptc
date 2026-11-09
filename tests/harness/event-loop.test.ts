/* Piped-stdin differential tests: the corpus harness closes both
 * children's stdin immediately (programs must see the same empty closed
 * stream), so the stdin DATA paths — chunk delivery to once-'data'
 * listeners, for-await over process.stdin, the race-then-destroy timeout
 * shape — run here, where the harness controls what flows into the pipe
 * and when. Node stays the oracle: same program, same stdin script, same
 * stdout bytes and exit code. SCRIPTC_SAN=1 sanitizes the native side like
 * the corpus. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { eventLoopCases, stdinAsReadableCases, type StdinScript } from "./event-loop-cases.js";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureDir = join(repoRoot, "tests/fixtures/event-loop");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface RunResult {
  stdout: string;
  exitCode: number;
}

function runWithStdin(cmd: string, args: string[], script: StdinScript): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: "utf8" }, (err, stdout) => {
      const e = err as { code?: unknown } | null;
      if (e && typeof e.code !== "number") {
        reject(err);
        return;
      }
      resolve({ stdout, exitCode: e ? (e.code as number) : 0 });
    });
    void (async () => {
      for (const w of script.writes) {
        await new Promise((r) => setTimeout(r, w.delayMs));
        child.stdin?.write(w.data, w.latin1 ? "latin1" : "utf8");
      }
      if (script.end) child.stdin?.end();
      // Held-open pipes close when the child exits (execFile cleans up).
    })();
  });
}

async function compileFixture(name: string): Promise<string> {
  const file = join(fixtureDir, name);
  const key = createHash("sha256")
    .update(file)
    .update(readFileSync(file))
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(file, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    // Pinned: piped-stdin timing fixtures were written against the C
    // lane; lane identity stays fixed so a diff means the stdin/event-loop
    // story changed, never that the default backend moved.
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "event-loop fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

async function differential(fixture: string, script: StdinScript): Promise<void> {
  const binary = await compileFixture(fixture);
  const [nodeRes, nativeRes] = await Promise.all([
    runWithStdin("node", [join(fixtureDir, fixture)], script),
    runWithStdin(binary, [], script),
  ]);
  expect(nativeRes.stdout).toBe(nodeRes.stdout);
  expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
}

describe("event loop: piped stdin (differential)", () => {
  // The case table lives in event-loop-cases.ts: the Linux lane runs the
  // identical fixtures with the identical stdin scripts in-container.
  test.for(eventLoopCases.map((c) => [c.title, c] as const))("%s", async ([, c]) => {
    await differential(c.fixture, c.script);
  });
});

// process.stdin where a node:stream Readable is declared is withheld (see
// processStreamAs in general-streams.ts): the stream and the process.stdin
// name do not yet answer one readable state, as the one object does in
// Node. These cases and the tests marked skip below are Node's answers for
// the conversion and return with it.
describe.skip("event loop: stdin as a Readable (differential, withheld)", () => {
  test.for(stdinAsReadableCases.map((c) => [c.title, c] as const))("%s", async ([, c]) => {
    await differential(c.fixture, c.script);
  });
});

// Until then each of those programs stops at its first conversion by name,
// as it did before the conversion existed, instead of reading the input
// through two states.
const withheldStdinFixtures = Array.from(
  new Set([
    ...stdinAsReadableCases.map((c) => c.fixture),
    "../node-types/stdin-readable-own-iteration.ts",
    "../node-types/stdin-readable-own-readable-pipe.ts",
    "../node-types/stdin-readable-unread-end.ts",
  ]),
);
test.for(withheldStdinFixtures)(
  "process.stdin where a Readable is declared stops by name: %s",
  async (fixture) => {
    const binary = await compileFixture(fixture);
    const result = await new Promise<{ stdout: string; stderr: string; code: number }>(
      (resolve) => {
        const child = execFile(binary, [], { encoding: "utf8" }, (err, stdout, stderr) => {
          const e = err as { code?: unknown } | null;
          resolve({ stdout, stderr, code: e && typeof e.code === "number" ? e.code : 0 });
        });
        // The program may be gone when the pipe closes: the pipe's own error
        // is not the test's.
        child.stdin?.on("error", () => {});
        child.stdin?.end();
      },
    );
    expect(result.stderr).toContain("expected Readable");
    expect(result.stderr).toContain("got ProcessStream");
    // 1, except in the sanitized lane for the program that is stopped while
    // its own iteration of process.stdin is parked: that one exits 99
    // there, as the same program built without this branch does.
    expect(result.code).not.toBe(0);
  },
);

// Not differential: once an encoding is set Node hands out strings, and a
// consumer compiled for bytes cannot take one. The compiled program refuses
// by name; before, it handed out the raw bytes (a listener that appended its
// chunks printed their decimal values).
test.for([
  [
    "a bytes 'data' listener",
    "stdin-set-encoding-bytes.ts",
    "process.stdin 'data' listener takes a Buffer, but setEncoding makes the chunks strings",
  ],
  [
    "read()",
    "stdin-set-encoding-read.ts",
    "process.stdin.read() answers a Buffer, but setEncoding makes the chunks strings",
  ],
  [
    "for await",
    "stdin-set-encoding-for-await.ts",
    "for await over process.stdin takes Buffers, but setEncoding makes the chunks strings",
  ],
] as const)("stdin under setEncoding: %s is refused by name", async ([, fixture, message]) => {
  const binary = await compileFixture(fixture);
  const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const child = execFile(binary, [], { encoding: "utf8" }, (err, stdout, stderr) => {
      const e = err as { code?: unknown } | null;
      resolve({ stdout, stderr, code: e && typeof e.code === "number" ? e.code : 0 });
    });
    child.stdin?.end("Say hello\n");
  });
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(message);
  expect(result.stderr).toContain("SC2020");
  expect(result.code).toBe(1);
});

// Not differential either: Node reads the one stream through both names;
// these two forms are refused by name instead of answering otherwise.
// (Withheld with the conversion.)
test.skip.for([
  [
    "for await over process.stdin",
    "../node-types/stdin-readable-own-iteration.ts",
    "for await over process.stdin is not supported in a program that also passes process.stdin as a stream.Readable",
  ],
  [
    "a pipe while process.stdin has a 'readable' listener",
    "../node-types/stdin-readable-own-readable-pipe.ts",
    "process.stdin piped as a stream.Readable while process.stdin has a 'readable' listener is not supported",
  ],
] as const)(
  "stdin also handed on as a Readable: %s is refused by name",
  async ([, fixture, message]) => {
    const binary = await compileFixture(fixture);
    const result = await new Promise<{ stdout: string; stderr: string; code: number }>(
      (resolve) => {
        const child = execFile(binary, [], { encoding: "utf8" }, (err, stdout, stderr) => {
          const e = err as { code?: unknown } | null;
          resolve({ stdout, stderr, code: e && typeof e.code === "number" ? e.code : 0 });
        });
        // Both refusals come before any input is read, so the program may be
        // gone when the pipe closes: nothing is written, and the pipe's own
        // error is not the test's.
        child.stdin?.on("error", () => {});
        child.stdin?.end();
      },
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("SC2020");
    expect(result.code).toBe(1);
  },
);

test.skip("stdin as a Readable: a closed descriptor 0 is an input that ends at once", async () => {
  // Node opens /dev/null on a closed descriptor 0 at startup, so its stdin
  // ends without input; the paused iteration answers the same.
  const binary = await compileFixture("../node-types/stdin-readable-paused-iteration.ts");
  const result = await new Promise<{ stdout: string; code: number }>((resolve) => {
    execFile(
      "sh",
      ["-c", 'exec "$0" <&-', binary],
      { encoding: "utf8", timeout: 20_000 },
      (err, stdout) => {
        const e = err as { code?: unknown } | null;
        resolve({ stdout, code: e ? (typeof e.code === "number" ? e.code : -1) : 0 });
      },
    );
  });
  expect(result.stdout).toBe(
    "handed on true false true\niterated 0 all Buffers: true\nafter true true\n",
  );
  expect(result.code).toBe(0);
});

// Node reads a file through a stream that does not read again at the end
// of the input, and a pipe through one that does. Under a 'readable'
// listener that never reads, an empty pipe therefore ends the stream at
// once and an empty file ends it at the next read. The expected lines are
// Node's for each input (the closed descriptor is /dev/null there).
// (Withheld with the conversion.)
test.skip.for([
  ["an empty file", '"$0" < /dev/null', "after 'readable': ended false\nend\nexit\n"],
  ["a closed descriptor 0", 'exec "$0" <&-', "after 'readable': ended false\nend\nexit\n"],
  ["an empty pipe", ': | "$0"', "end\nafter 'readable': ended true\nexit\n"],
] as const)(
  "stdin as a Readable: %s ends the stream as Node's stream for it does",
  async ([, command, expected]) => {
    const binary = await compileFixture("../node-types/stdin-readable-unread-end.ts");
    const result = await new Promise<{ stdout: string; code: number }>((resolve) => {
      execFile(
        "sh",
        ["-c", command, binary],
        { encoding: "utf8", timeout: 20_000 },
        (err, stdout) => {
          const e = err as { code?: unknown } | null;
          resolve({ stdout, code: e ? (typeof e.code === "number" ? e.code : -1) : 0 });
        },
      );
    });
    expect(result.stdout).toBe(expected);
    expect(result.code).toBe(0);
  },
);
