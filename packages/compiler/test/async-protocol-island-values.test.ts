// A Node island's async iterable never arrives through a flow site: the
// program reads a member the island declares as `AsyncIterable<Item>` and
// iterates it where it stands. The value is typed by the island's
// declarations, so the protocol types those declarations name hold the
// checked-dynamic value (frontend/lowering/async-protocol-holders.ts,
// markIslandDeclared). Without that the type stays a compiled generator and
// the island's value is refused at the boundary (SC8010), where the program
// used to lower: the per-program relower this analysis replaced made every
// protocol type dynamic as soon as a pass failed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { analyzeWithFrontend } from "../src/frontend/analysis.js";
import { runFrontend } from "../src/frontend/pipeline.js";
import { loadProgram } from "../src/frontend/program-node.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FEED_JS = `
exports.send = async function send(count) {
  return {
    status: 200,
    stream: {
      [Symbol.asyncIterator]() {
        let next = 0;
        return {
          next: async () =>
            next < count ? { value: { id: ++next }, done: false } : { value: undefined, done: true },
        };
      },
    },
  };
};
exports.counter = function counter(limit) {
  return {
    [Symbol.asyncIterator]() {
      let n = 0;
      return {
        next: async () => (n < limit ? { value: n++, done: false } : { value: undefined, done: true }),
      };
    },
  };
};
`;

const FEED_TYPES = `
export interface Item {
  id: number;
}
export interface Reply {
  status: number;
  stream?: AsyncIterable<Item>;
}
export declare function send(count: number): Promise<Reply>;
export declare function counter(limit: number): AsyncIterable<number>;
`;

/** What one lowering decided: its diagnostic codes (performance notes left
 * out) and the analysis's own record (the `async-protocol-flows` line of
 * SCRIPTC_TIMING): how many element types it marked (-1 for every one) and
 * how many protocol types the island's declarations named. */
interface Decided {
  codes: string[];
  marked: number | null;
  islandDeclared: number | null;
}

/** Lowers `main` as a project whose package `feed-pkg` runs in a Node
 * island. */
function decide(main: string, types = FEED_TYPES): Decided {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-async-protocol-island-"));
  scratch.push(dir);
  const pkg = join(dir, "node_modules", "feed-pkg");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "feed-pkg", version: "1.0.0", main: "index.js", types: "index.d.ts" }),
  );
  writeFileSync(join(pkg, "index.js"), FEED_JS);
  writeFileSync(join(pkg, "index.d.ts"), types);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "island-feed",
      private: true,
      type: "module",
      scriptc: { packages: { "feed-pkg": "node" } },
    }),
  );
  writeFileSync(join(dir, "main.ts"), main);
  const previous = process.env["SCRIPTC_TIMING"];
  const stderr = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.env["SCRIPTC_TIMING"] = "1";
  try {
    const result = analyzeWithFrontend(
      join(dir, "main.ts"),
      { nodeIslands: { mode: "auto" } },
      process.platform,
      (entry, npmStatic, externalTypes, libraryNpmStatic, options) =>
        runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options),
    );
    const scans = lines
      .filter((line) => line.startsWith("scriptc lowering "))
      .map(
        (line) =>
          JSON.parse(line.slice("scriptc lowering ".length)) as {
            phase: string;
            marked?: number;
            island_declared?: number;
          },
      )
      .filter(({ phase }) => phase === "async-protocol-flows");
    const scan = scans[scans.length - 1];
    return {
      codes: result.coverage.diagnostics
        .map((d) => d.code)
        .filter((code) => !code.startsWith("SC6")),
      marked: scan?.marked ?? null,
      islandDeclared: scan?.island_declared ?? null,
    };
  } finally {
    process.stderr.write = stderr;
    if (previous === undefined) delete process.env["SCRIPTC_TIMING"];
    else process.env["SCRIPTC_TIMING"] = previous;
  }
}

test("an island member declared with a protocol type is iterated where it is read", () => {
  // `Reply.stream` over Item and `counter` over number: both element types
  // are marked, and the member read lowers (it was SC8010).
  expect(
    decide(`
import { send } from "feed-pkg";
async function main(): Promise<void> {
  const reply = await send(3);
  for await (const item of reply.stream!) console.log(item.id);
}
main();
`),
  ).toEqual({ codes: [], marked: 2, islandDeclared: 2 });
});

test("an island call declared with a protocol type flows into a native slot of it", () => {
  expect(
    decide(`
import { counter } from "feed-pkg";
async function total(source: AsyncIterable<number>): Promise<number> {
  let sum = 0;
  for await (const n of source) sum += n;
  return sum;
}
async function* own(): AsyncGenerator<number> {
  yield 5;
}
async function main(): Promise<void> {
  for await (const n of counter(2)) console.log(n);
  console.log(await total(counter(3)), await total(own()));
}
main();
`),
  ).toEqual({ codes: [], marked: 2, islandDeclared: 2 });
});

test("a generic island declaration stands for every element type", () => {
  expect(
    decide(
      `
import { pages } from "feed-pkg";
async function main(): Promise<void> {
  for await (const page of pages<string>("a")) console.log(page);
}
main();
`,
      `export declare function pages<T>(first: T): AsyncIterable<T>;\n`,
    ),
  ).toEqual({ codes: [], marked: -1, islandDeclared: 1 });
});

test("an island that declares no protocol type marks nothing", () => {
  expect(
    decide(
      `
import { double } from "feed-pkg";
async function* own(): AsyncGenerator<number> {
  yield double(5);
}
async function total(source: AsyncIterable<number>): Promise<number> {
  let sum = 0;
  for await (const n of source) sum += n;
  return sum;
}
total(own()).then((sum) => console.log(sum));
`,
      `export declare function double(n: number): number;\n`,
    ),
  ).toEqual({ codes: [], marked: 0, islandDeclared: 0 });
});
