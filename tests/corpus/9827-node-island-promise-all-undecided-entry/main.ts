// @requires-libnode
/// <reference path="./shims.d.ts" />
// Promise.all with an entry `factory ?? promise of a factory`, where the
// factory's type returns a class of a package the program declares itself
// (shims.d.ts) and only the default factory imports. Until that import()
// lowers nothing names the package, so the factory's type has no static
// form and the entry is a checked-dynamic value. Its position of the result
// settles with that value; the default factory then lowers, and the package
// runs in a Node island.
import type { Meter } from "dialmeter";

type MeterFactory = (options: Record<string, unknown>) => Meter;

const defaultFactory = async (): Promise<MeterFactory> => {
  const { Meter } = await import("dialmeter");
  return (options) => new Meter(options);
};

interface Built {
  text: string;
  factory: MeterFactory;
}

// Beside import() entries of an island package, destructured by member.
async function build(root: string, given: MeterFactory | undefined): Promise<Built> {
  const [{ bump }, { label }, make] = await Promise.all([
    import("tallybox"),
    import("tallybox"),
    given ?? defaultFactory(),
  ]);
  const meter = make({ start: bump(), root });
  return { text: label + " " + meter.read(), factory: make };
}

// Beside a plain promise, with no import() entry.
async function alone(given: MeterFactory | undefined): Promise<string> {
  const [n, make] = await Promise.all([Promise.resolve(2), given ?? defaultFactory()]);
  return make({ start: n }).read();
}

// The same choice spelled as a conditional.
async function conditional(given: MeterFactory | undefined): Promise<string> {
  const [n, make] = await Promise.all([
    Promise.resolve(3),
    given !== undefined ? given : defaultFactory(),
  ]);
  const meter = make({ start: n });
  return meter.read() + " " + (await meter.face("dial"));
}

// The same call in a function that never runs.
async function never(given: MeterFactory | undefined): Promise<string> {
  const [{ label }, make] = await Promise.all([import("tallybox"), given ?? defaultFactory()]);
  return label + make({ start: 1 }).read();
}

const first = await build("r", undefined);
console.log(first.text);
// The factory the first call settled with is the given one of the second.
const second = await build("r", first.factory);
console.log(second.text, second.factory === first.factory);
console.log(await alone(undefined), await alone(first.factory));
console.log(await conditional(undefined));
if (process.argv.length > 99) console.log(await never(undefined));
