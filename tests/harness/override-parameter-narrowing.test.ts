import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// An override may declare a narrower parameter than the method it overrides
// (override-parameter-narrowing.ts). Calls that pass a value the override
// declares match Node (tests/corpus/997x-override-narrowed-parameter-*).
// These programs reach the override, through a wider type, with a value it
// does NOT declare: Node runs the body with that value; the compiled slot
// checks the argument and throws a TypeError naming the method and the
// parameter, before the body runs.
async function run(source: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-override-parameter-narrowing-"));
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

const cell = `function cell(label: string, run: () => unknown): void {
  try { console.log(label, JSON.stringify(run())); }
  catch (error) { console.log(label, "threw", (error as Error).name + ":", (error as Error).message); }
}
`;
const through = "and a call that reached it through a wider type passed";

test("union arms: a value of an arm the override does not declare throws at the slot, through every wider path", async () => {
  const { stdout, stderr, code } = await run(`${cell}
class Canvas {
  ran: string[] = [];
  paint(color: number | boolean | string): string { this.ran.push("canvas"); return "canvas"; }
  stamp(mark: string | number[]): string { return "canvas"; }
  mix(part: number | boolean | null): string { return "canvas"; }
}
class Sketch extends Canvas {
  paint(color: string | number): string { this.ran.push("sketch"); return typeof color === "string" ? "s" + color : "n" + (color + 1); }
  stamp(mark: string): string { return "sketch " + mark.length; }
  mix(part: number | null): string { return part === null ? "nothing" : "x" + part * 2; }
}
interface Surface { paint(color: number | boolean | string): string; }
const sketch = new Sketch();
const asCanvas: Canvas = sketch;
const asSurface: Surface = sketch;
const untyped: any = sketch;
cell("base narrow", () => asCanvas.paint("b"));
cell("base wide", () => asCanvas.paint(true));
cell("interface wide", () => asSurface.paint(false));
cell("any wide", () => untyped.paint(true));
const stored: (color: number | boolean | string) => string = asCanvas.paint.bind(asCanvas);
cell("stored wide", () => stored(true));
cell("base instance wide", () => new Canvas().paint(true));
cell("stamp array", () => asCanvas.stamp([1]));
cell("stamp string", () => asCanvas.stamp("abc"));
cell("mix boolean", () => asCanvas.mix(true));
cell("mix null", () => asCanvas.mix(null));
console.log(sketch.ran.join(","));
`);
  const paint = `threw TypeError: Sketch.paint: this override declares parameter 'color' as 'number | string', ${through} a 'boolean' value`;
  expect(stdout.split("\n")).toEqual([
    'base narrow "sb"',
    `base wide ${paint}`,
    `interface wide ${paint}`,
    `any wide ${paint}`,
    `stored wide ${paint}`,
    'base instance wide "canvas"',
    `stamp array threw TypeError: Sketch.stamp: this override declares parameter 'mark' as 'string', ${through} a 'number[]' value`,
    'stamp string "sketch 3"',
    `mix boolean threw TypeError: Sketch.mix: this override declares parameter 'part' as 'number | null', ${through} a 'boolean' value`,
    'mix null "nothing"',
    // The override's body ran once: every refused call stopped at the slot.
    "sketch",
    "",
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("an optional parameter made required, and a subclass: undefined and a base instance throw", async () => {
  const { stdout, stderr, code } = await run(`${cell}
class Base {
  greet(name?: string): string { return "base " + (name ?? "nobody"); }
}
class Sub extends Base {
  greet(name: string): string { return "sub " + name.length; }
}
class Animal {
  name = "animal";
  feed(other: Animal): string { return this.name + " feeds " + other.name; }
}
class Dog extends Animal {
  name = "dog";
  breed = "lab";
  feed(other: Dog): string { return this.name + " feeds " + other.breed; }
}
class Puppy extends Dog { breed = "pup"; }
const asBase: Base = new Sub();
const untyped: any = asBase;
cell("given", () => asBase.greet("abcd"));
cell("omitted", () => asBase.greet());
cell("undefined", () => asBase.greet(undefined));
cell("any omitted", () => untyped.greet());
const asAnimal: Animal = new Dog();
cell("puppy", () => asAnimal.feed(new Puppy()));
cell("animal", () => asAnimal.feed(new Animal()));
cell("puppy receiver", () => (new Puppy() as Animal).feed(new Animal()));
`);
  const greet = `threw TypeError: Sub.greet: this override declares parameter 'name' as 'string', ${through} undefined`;
  const feed = `threw TypeError: Dog.feed: this override declares parameter 'other' as 'Dog', ${through} a 'Animal' value that is not a 'Dog'`;
  expect(stdout.split("\n")).toEqual([
    'given "sub 4"',
    `omitted ${greet}`,
    `undefined ${greet}`,
    `any omitted ${greet}`,
    'puppy "dog feeds pup"',
    `animal ${feed}`,
    `puppy receiver ${feed}`,
    "",
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("a chain that narrows twice checks at the slot of the class that runs", async () => {
  const { stdout, stderr, code } = await run(`${cell}
class Base { step(v: string | number | boolean): string { return "base"; } }
class Mid extends Base { step(v: string | number): string { return "mid " + String(v); } }
class Low extends Mid { step(v: string): string { return "low " + v.length; } }
const lowAsMid: Mid = new Low();
const lowAsBase: Base = new Low();
const midAsBase: Base = new Mid();
cell("low string", () => lowAsBase.step("abc"));
cell("low number through mid", () => lowAsMid.step(1));
cell("low boolean through base", () => lowAsBase.step(true));
cell("mid number", () => midAsBase.step(5));
cell("mid boolean", () => midAsBase.step(false));
`);
  expect(stdout.split("\n")).toEqual([
    'low string "low 3"',
    `low number through mid threw TypeError: Low.step: this override declares parameter 'v' as 'string', ${through} a 'number' value`,
    `low boolean through base threw TypeError: Low.step: this override declares parameter 'v' as 'string', ${through} a 'boolean' value`,
    'mid number "mid 5"',
    `mid boolean threw TypeError: Mid.step: this override declares parameter 'v' as 'number | string', ${through} a 'boolean' value`,
    "",
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("fewer parameters: an untyped call that passes fewer arguments than the slot takes throws", async () => {
  const { stdout, stderr, code } = await run(`${cell}
class Courier {
  deliver(parcel: string, floor: number): string { return "courier " + parcel + " " + floor; }
}
class Drone extends Courier {
  deliver(): string { return "drone"; }
}
const drone = new Drone();
const asCourier: Courier = drone;
const untyped: any = drone;
cell("direct", () => drone.deliver());
cell("base", () => asCourier.deliver("x", 1));
cell("any full", () => untyped.deliver("z", 2));
cell("any none", () => untyped.deliver());
cell("length", () => drone.deliver.length);
`);
  expect(stdout.split("\n")).toEqual([
    'direct "drone"',
    'base "drone"',
    'any full "drone"',
    // The untyped call enters through the slot, whose parameters are the
    // base's: Node calls the override, which declares none.
    "any none threw TypeError: expected string at $[0], got undefined",
    "length 0",
    "",
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});
