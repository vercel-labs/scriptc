/* Lowering a chain of calls takes work in proportion to its length.
 *
 * A method call is claimed by one of about a hundred forms, and several of
 * them have to see the receiver's lowered value to decide: each lowered the
 * receiver for itself, so a chain cost two lowerings per link through
 * classes and records and three through array methods, multiplied at every
 * link (16 links through an interface took 7.6 s, 22 about five minutes).
 * The receiver is now lowered once per call (Lowerer.dispatchedReceiver).
 *
 * The test counts lowerings, not seconds, so it does not depend on the
 * machine: for each shape, the lowerings added by links 17 to 24 must not
 * exceed those added by links 9 to 16 by more than a quarter. That holds
 * for a linear cost, and fails for a quadratic one (1.67 times) and for
 * anything steeper. A shape that multiplies per link does not get that far:
 * its 24-link chain passes the attempt budget and is refused by name. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { analyze } from "../src/index.js";
import {
  setLowerExprAttemptsFloor,
  takeLowerExprAttemptsPeak,
} from "../src/frontend/lowering/lower-exprs.js";

let directory: string;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "scriptc-call-chain-scaling-"));
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** `root` followed by `links` copies of what `link` gives for each index. */
function chain(root: string, links: number, link: (index: number) => string): string {
  let text = root;
  for (let i = 0; i < links; i++) text += `\n  ${link(i)}`;
  return text;
}

const BUILDER = `interface Builder { step(n: number): Builder; done(): number }
function make(total: number): Builder {
  return { step: (n) => make(total + n), done: () => total };
}
`;

/** One program per shape and length; every one compiles statically. */
const SHAPES: Record<string, (links: number) => string> = {
  "calls through an interface": (links) =>
    `${BUILDER}const root: Builder = make(0);
console.log(${chain("root", links, (i) => `.step(${i})`)}
  .done());
`,
  "a builder whose methods return this": (links) =>
    `class Counter {
  total = 0;
  step(n: number): this {
    this.total += n;
    return this;
  }
}
console.log(${chain("new Counter()", links, (i) => `.step(${i})`)}
  .total);
`,
  "methods returning a new instance": (links) =>
    `class Money {
  constructor(readonly cents: number) {}
  plus(n: number): Money {
    return new Money(this.cents + n);
  }
}
console.log(${chain("new Money(1)", links, (i) => `.plus(${i})`)}
  .cents);
`,
  "a chain inside a generic function": (links) =>
    `${BUILDER}function run<T extends Builder>(root: T): number {
  return ${chain("root", links, (i) => `.step(${i})`)}
    .done();
}
console.log(run(make(0)));
`,
  "optional calls": (links) =>
    `interface Step { step(n: number): Step | undefined; done(): number }
function start(total: number): Step | undefined {
  return total > 1000 ? undefined : { step: (n) => start(total + n), done: () => total };
}
const root = start(0);
console.log(${chain("root", links, (i) => `?.step(${i})`)}
  ?.done());
`,
  "string methods": (links) =>
    `const seed: number = 7;
console.log(${chain("`  seed-${seed}  `", links, (i) =>
      i % 3 === 0 ? ".trim()" : i % 3 === 1 ? ".toUpperCase()" : `.padStart(${i + 12}, "*")`,
    )});
`,
  "promise chains": (links) =>
    `const result = ${chain("Promise.resolve(1)", links, (i) => `.then((n) => n + ${i})`)};
result.then((n) => console.log(n));
`,
  "nested calls as arguments": (links) => {
    let text = "1";
    for (let i = 0; i < links; i++) text = `${i % 2 === 0 ? "inc" : "dbl"}(${text})`;
    return `function inc(n: number): number { return n + 1; }
function dbl(n: number): number { return n * 2; }
console.log(${text});
`;
  },
  "method calls nested as arguments": (links) => {
    let text = "base";
    for (let i = 0; i < links; i++) text = `base.add(${text})`;
    return `class Vec {
  constructor(readonly x: number) {}
  add(o: Vec): Vec {
    return new Vec(this.x + o.x);
  }
}
const base = new Vec(1);
console.log(${text}.x);
`;
  },
  "pipe(seed, f, g, h)": (links) => {
    let steps = "";
    for (let i = 0; i < links; i++) steps += `,\n  (n) => n + ${i}`;
    return `function pipe(seed: number, ...steps: Array<(n: number) => number>): number {
  let value = seed;
  for (const step of steps) value = step(value);
  return value;
}
console.log(pipe(
  1${steps},
));
`;
  },
};

/** The most lowerings one statement of `source` took. */
function lowerings(name: string, links: number, source: string): number {
  const dir = join(directory, `${name.replace(/\W+/g, "-")}-${links}`);
  mkdirSync(dir);
  const entry = join(dir, "main.ts");
  writeFileSync(entry, source);
  takeLowerExprAttemptsPeak();
  const { coverage } = analyze(entry, {});
  expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  return takeLowerExprAttemptsPeak();
}

for (const [name, shape] of Object.entries(SHAPES)) {
  test(`${name}: each further link costs the same number of lowerings`, () => {
    // Out of the way of the per-node budget (2,000 lowerings for each node
    // of the statement), which is what stops a shape that multiplies.
    const previous = setLowerExprAttemptsFloor(20_000);
    try {
      const short = lowerings(name, 8, shape(8));
      const middle = lowerings(name, 16, shape(16));
      const long = lowerings(name, 24, shape(24));
      expect(middle).toBeGreaterThan(short);
      expect(long - middle).toBeLessThanOrEqual((middle - short) * 1.25);
    } finally {
      setLowerExprAttemptsFloor(previous);
    }
  }, 120_000);
}
