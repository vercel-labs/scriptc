/* Lowering a chain of calls takes work in proportion to its length.
 *
 * A method call is claimed by one of about a hundred forms, and several of
 * them have to see the receiver's lowered value to decide: each lowered the
 * receiver for itself, so a chain cost two lowerings per link through
 * classes and records and three through array methods, multiplied at every
 * link (16 links through an interface took 7.6 s, 22 about five minutes).
 * The receiver is now lowered once per call (Lowerer.dispatchedReceiver),
 * and any other operand an expression asks for twice is lowered once when
 * its lowering leaves nothing behind (Lowerer.keptOperands).
 *
 * The test counts lowerings, not seconds, so it does not depend on the
 * machine: for each shape, the lowerings added by links 17 to 24 must not
 * exceed those added by links 9 to 16 by more than a quarter. That holds
 * for a linear cost, and fails for a quadratic one (1.67 times) and for
 * anything steeper. A shape that multiplies per link does not get that far:
 * its 24-link chain passes the attempt budget and is refused by name.
 *
 * A lowering inside a probe does not report the declaration slots whose
 * type has no static lowering; the kept receiver carries those notes, and
 * the first request outside a probe reports them. A note recorded again at
 * every link multiplied through the chain the same way (a chain of eighteen
 * array methods reading such a declaration took the heap past its limit),
 * so the second test counts note recordings too, and a note must reach
 * coverage once per slot.
 *
 * A single expression that lowers many operands (an array literal with
 * thousands of arithmetic elements) kept every one of them in a list that
 * each further operand scanned from its end, so its lookups were quadratic;
 * the operands are keyed by node now, and the third test counts lookups the
 * same way. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { analyze } from "../src/index.js";
import {
  takeKeptOperandLookups,
  takeProbedSlotNoteRequests,
} from "../src/frontend/lowering/lowerer.js";
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

/** A declaration whose type has no static lowering: its slot is reported
 * as dynamic, from inside whichever probe first meets it. */
const DEGRADED = `type Progress = (done: number, total: number) => void;
type Callbacks = Progress | AbortSignal | Map<string, (x: number) => string> | Set<number>;
const all: (Callbacks | number)[] = [7];
`;

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
  "a receiver whose type is a union of classes": (links) =>
    `class Even {
  constructor(readonly n: number) {}
  next(by: number): Even | Odd {
    return (this.n + by) % 2 === 0 ? new Even(this.n + by) : new Odd(this.n + by);
  }
}
class Odd {
  constructor(readonly n: number) {}
  next(by: number): Even | Odd {
    return (this.n + by) % 2 === 0 ? new Even(this.n + by) : new Odd(this.n + by);
  }
}
const start: Even | Odd = new Even(0);
console.log(${chain("start", links, (i) => `.next(${i})`)}
  .n);
`,
  "Map methods": (links) =>
    `console.log(${chain("new Map<string, number>()", links, (i) => `.set("k${i}", ${i})`)}
  .size);
`,
  "calls taking arrow functions": (links) =>
    `interface Later { then(f: (n: number) => number): Later; done(): number }
function later(total: number): Later {
  return { then: (f) => later(f(total)), done: () => total };
}
console.log(${chain("later(0)", links, (i) => `.then((n) => n + ${i})`)}
  .done());
`,
  "array methods taking arrow functions": (links) =>
    `const values = [1, 2, 3];
console.log(${chain("values", links, (i) =>
      i % 2 === 0 ? `.map((n) => n + ${i})` : `.filter((n) => n !== ${i})`,
    )}
  .length);
`,
  "array methods without functions": (links) =>
    `const values = [3, 1, 2];
console.log(${chain("values", links, (i) =>
      i % 3 === 0 ? ".slice(0)" : i % 3 === 1 ? `.concat([${i}])` : ".reverse()",
    )}
  .length);
`,
  "array methods reading a degraded declaration": (links) =>
    `${DEGRADED}const values = [1, 2, 3];
console.log(${chain("values", links, (i) =>
      i === 0
        ? ".map((n) => n + all.length)"
        : i % 2 === 0
          ? `.map((n) => n + ${i})`
          : `.filter((n) => n !== ${i})`,
    )}
  .length);
`,
  "generic methods taking arrow functions": (links) =>
    `class Box<T> {
  constructor(readonly value: T) {}
  map<U>(f: (value: T) => U): Box<U> {
    return new Box(f(this.value));
  }
}
console.log(${chain("new Box(1)", links, (i) => `.map((n) => n + ${i})`)}
  .value);
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
  "Object statics nested as arguments": (links) => {
    let text = "seed";
    for (let i = 0; i < links; i++) text = `Object.keys(${text})`;
    return `const seed: string[] = ["a", "b"];
console.log(${text}.length);
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

/** The dynamic slots `source` reports and the slot notes it recorded. */
function notes(
  name: string,
  links: number,
  source: string,
): {
  recorded: number;
  slots: string[];
} {
  const dir = join(directory, `${name.replace(/\W+/g, "-")}-notes-${links}`);
  mkdirSync(dir);
  const entry = join(dir, "main.ts");
  writeFileSync(entry, source);
  takeProbedSlotNoteRequests();
  const { coverage } = analyze(entry, {});
  expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  return {
    recorded: takeProbedSlotNoteRequests(),
    slots: (coverage.dynamicSlots ?? []).map((slot) => `${slot.slot} ${slot.name}`),
  };
}

test("a degraded declaration read along a chain is noted once per slot, not once per link", () => {
  const shape = SHAPES["array methods reading a degraded declaration"]!;
  const scan = (links: number) => notes("degraded-declaration", links, shape(links));
  const short = scan(8);
  const middle = scan(16);
  const long = scan(24);
  // The declaration is met inside the chain, so the probe defers its
  // report; the chain's kept receivers carry it to the request outside.
  expect(short.recorded).toBeGreaterThan(0);
  expect(middle.recorded).toBeGreaterThan(short.recorded);
  expect(long.recorded - middle.recorded).toBeLessThanOrEqual(
    (middle.recorded - short.recorded) * 1.25,
  );
  expect(long.slots).toContain("global all");
}, 120_000);

/** The lowerings and operand lookups one array literal of `elements`
 * arithmetic elements takes. */
function wideArray(elements: number): { lowerings: number; lookups: number } {
  const dir = join(directory, `wide-array-${elements}`);
  mkdirSync(dir);
  const entry = join(dir, "main.ts");
  const items: string[] = [];
  for (let i = 0; i < elements; i++) items.push(`base + step * ${i} + ${i % 7}`);
  writeFileSync(
    entry,
    `const base = 1;\nconst step = 2;\nconst xs = [${items.join(", ")}];\nconsole.log(xs.length);\n`,
  );
  takeLowerExprAttemptsPeak();
  takeKeptOperandLookups();
  const { coverage } = analyze(entry, {});
  expect(coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  return { lowerings: takeLowerExprAttemptsPeak(), lookups: takeKeptOperandLookups() };
}

test("a wide expression looks each operand up once, not once per earlier operand", () => {
  const short = wideArray(500);
  const long = wideArray(2000);
  // Four times the elements may cost no more than a quarter more lowerings
  // or operand lookups per element. One lookup per request follows the
  // elements; the list this replaced scanned every operand recorded since,
  // so four times the elements multiplied its lookups by sixteen.
  expect(long.lookups / 2000).toBeLessThanOrEqual((short.lookups / 500) * 1.25);
  expect(long.lowerings / 2000).toBeLessThanOrEqual((short.lowerings / 500) * 1.25);
}, 120_000);

/** One expression with `width` operands, each a sum the lowering keeps. */
const WIDE: Record<string, (width: number) => string> = {
  "an array literal": (width) =>
    `const seed: number = Number(process.argv.length);
const wide = [
  ${Array.from({ length: width }, (_, i) => `seed + ${i}`).join(",\n  ")},
];
console.log(wide.length);
`,
  "an object literal": (width) =>
    `const seed: number = Number(process.argv.length);
const wide = {
  ${Array.from({ length: width }, (_, i) => `p${i}: seed + ${i}`).join(",\n  ")},
};
console.log(wide.p0);
`,
  "an argument list": (width) =>
    `const seed: number = Number(process.argv.length);
function count(...values: number[]): number {
  return values.length;
}
console.log(count(
  ${Array.from({ length: width }, (_, i) => `seed + ${i}`).join(",\n  ")},
));
`,
};

for (const [name, shape] of Object.entries(WIDE)) {
  test(`${name} of 10,000 operands costs the same per operand as one of 2,000`, () => {
    // The widest case, for each list an expression can have: five times
    // the operands may cost no more than a quarter more lowerings or
    // operand lookups per operand. Scanned from a list, 10,000 operands
    // compared 50 to 100 million kept entries.
    const measure = (width: number): { lowerings: number; lookups: number } => {
      takeKeptOperandLookups();
      const count = lowerings(`wide ${name}`, width, shape(width));
      return { lowerings: count, lookups: takeKeptOperandLookups() };
    };
    const narrow = measure(2_000);
    const wide = measure(10_000);
    expect(wide.lowerings).toBeGreaterThan(narrow.lowerings);
    expect(wide.lowerings / 10_000).toBeLessThanOrEqual((narrow.lowerings / 2_000) * 1.25);
    expect(wide.lookups / 10_000).toBeLessThanOrEqual((narrow.lookups / 2_000) * 1.25);
  }, 240_000);
}
