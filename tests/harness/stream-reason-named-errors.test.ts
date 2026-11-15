import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// A stream's reason may be any value, and Node hands it to whoever asks. A
// compiled program differs from Node, by name, in three places, and those
// names are the contract here (Node's answer is in each test's comment, so
// none of these is a differential program):
//
//   - an 'error' listener that declares an Error cannot be handed a number,
//     a string or a plain object: its conversion fails at the hand-over
//     (a failed checked conversion throws) instead of the listener reading
//     an Error the program never made;
//   - with no 'error' listener an object reason is refused by name, where
//     Node's ERR_UNHANDLED_ERROR message needs util.inspect of the object;
//   - a falsy value thrown by the source of Readable.from is refused by
//     name: without an error the stream would end as if nothing had failed.
async function run(source: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-stream-reason-named-errors-"));
  const entry = join(outDir, "main.ts");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return { stdout: "", stderr: "", code: -1 };
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code ?? -1 };
  }
}

const PRELUDE = `import { Readable, Writable } from "node:stream";

type Fields = { [key: string]: unknown };
function hasFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null;
}

// destroy() declares an Error; any other reason goes through the method as
// the stream has it.
function close(stream: unknown, reason: unknown): void {
  if (!hasFields(stream)) return;
  const destroy = stream.destroy;
  if (typeof destroy === "function") destroy.call(stream, reason);
}

function ledger(): Writable {
  return new Writable({
    write(_entry: Uint8Array | string, _encoding: string, done: () => void): void {
      done();
    },
  });
}
`;

/** A ledger with a listener that declares an Error, closed with `reason`. */
function declaredError(reason: string): string {
  return `${PRELUDE}
const book = ledger();
book.on("error", (failure: Error) => console.log("listener: " + failure.message));
book.on("close", () => console.log("closed"));
close(book, ${reason});
console.log("closing");
`;
}

// Node: the listener prints "listener: undefined" (a number has no message).
test.each([
  ["a number", "404", "number"],
  ["a string", '"page torn"', "string"],
  ["a plain object", '{ page: 12, line: "smudged" }', "object"],
  ["true", "true", "boolean"],
])(
  "a listener that declares an Error fails its conversion by name when the reason is %s",
  async (_label, reason, kind) => {
    const { stdout, stderr, code } = await run(declaredError(reason));
    expect(stdout).toBe("closing\n");
    expect(stderr).toContain(`Uncaught TypeError: expected Error at $[0], got ${kind}`);
    expect(code).not.toBe(0);
  },
  120_000,
);

test("the same listener is handed an Error, and a subclass of Error, as itself", async () => {
  const { stdout, stderr, code } = await run(`${PRELUDE}
class TornPage extends Error {
  page: number;
  constructor(page: number) {
    super("page torn");
    this.page = page;
  }
}
const book = ledger();
book.on("error", (failure: Error) => {
  console.log("listener: " + failure.message + (failure instanceof TornPage ? ", page " + failure.page : ""));
});
book.on("close", () => console.log("closed"));
close(book, new TornPage(12));
`);
  expect(stdout).toBe("listener: page torn, page 12\nclosed\n");
  expect(stderr).toBe("");
  expect(code).toBe(0);
}, 120_000);

// Node: an uncaught ERR_UNHANDLED_ERROR, "Unhandled error. ({ page: 12 })".
test("an object reason with no 'error' listener is refused by name", async () => {
  const { stdout, stderr, code } = await run(`${PRELUDE}
const book = ledger();
book.on("close", () => console.log("closed"));
close(book, { page: 12 });
console.log("closing");
`);
  expect(stdout).toBe("closing\n");
  expect(stderr).toContain(
    "emit('error') through an untyped value with this non-Error payload and no 'error' listener is not supported yet",
  );
  expect(code).not.toBe(0);
}, 120_000);

// Node: the for await ends with ERR_STREAM_PREMATURE_CLOSE.
test("a falsy value thrown by the source of Readable.from is refused by name", async () => {
  const { stdout, stderr, code } = await run(`import { Readable } from "node:stream";

async function* entries(): AsyncGenerator<string> {
  yield "entry 1";
  throw 0;
}

async function main(): Promise<void> {
  try {
    for await (const entry of Readable.from(entries())) console.log("read " + String(entry));
    console.log("ended");
  } catch (failure) {
    console.log(failure instanceof Error ? "caught: " + failure.message : "caught a value: " + String(failure));
  }
}

main().then(
  () => console.log("done"),
  () => console.log("failed"),
);
`);
  expect(stdout.split("\n")).toEqual([
    "read entry 1",
    "caught: a stream operator rejection that is not an Error object is not supported yet",
    "done",
    "",
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
}, 120_000);
