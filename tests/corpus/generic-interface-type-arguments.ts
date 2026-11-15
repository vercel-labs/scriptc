// A generic function whose parameter is an interface held as an untyped
// value has the same compiled signature at every type argument, while its
// body reads the interface's members at the type argument. Each set of
// type arguments takes its own instance: a function, a method, an arrow
// function, a function value, and the forms where the interface sits inside
// an array, a record, a callback or a nullable parameter.
export {};

interface Gauge<T> {
  read(): T;
  latest?: T;
}

class Steady<T> implements Gauge<T> {
  latest?: T;
  level: T;
  constructor(level: T) {
    this.level = level;
  }
  read(): T {
    return this.level;
  }
}

class Ticker implements Gauge<number> {
  latest?: number;
  ticks: number = 0;
  read(): number {
    this.ticks += 1;
    return this.ticks;
  }
}

type Span = { from: number; to: number };

function show(value: unknown): string {
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return `[${value.join(",")}]`;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return `${typeof value} ${String(value)}`;
}

function sample<T>(gauge: Gauge<T>): void {
  gauge.latest = gauge.read();
}

function kindOf<T>(gauge: Gauge<T>): string {
  const reading = gauge.read();
  return typeof reading;
}

function sampleLater<T>(gauge: Gauge<T>): () => void {
  return () => {
    gauge.latest = gauge.read();
  };
}

function sampleAll<T>(gauges: Gauge<T>[]): number {
  let count = 0;
  for (const gauge of gauges) {
    gauge.latest = gauge.read();
    count += 1;
  }
  return count;
}

function sampleHeld<T>(holder: { gauge: Gauge<T>; label: string }): string {
  holder.gauge.latest = holder.gauge.read();
  return holder.label;
}

function sampleThen<T>(gauge: Gauge<T>, done: (gauge: Gauge<T>) => void): void {
  gauge.latest = gauge.read();
  done(gauge);
}

function sampleIfAny<T>(gauge: Gauge<T> | null): boolean {
  if (gauge === null) return false;
  gauge.latest = gauge.read();
  return true;
}

function samplePair<A, B>(first: Gauge<A>, second: Gauge<B>): void {
  first.latest = first.read();
  second.latest = second.read();
}

// The type parameter appears in no annotation: only the type argument tells
// the instances apart.
function sampleAs<T>(gauge: Gauge<unknown>): void {
  const reading = gauge.read() as T;
  gauge.latest = reading;
}

const sampleArrow = <T,>(gauge: Gauge<T>): void => {
  gauge.latest = gauge.read();
};

class Station {
  samples: number = 0;
  sample<T>(gauge: Gauge<T>): void {
    this.samples += 1;
    gauge.latest = gauge.read();
  }
  static sample<T>(gauge: Gauge<T>): void {
    gauge.latest = gauge.read();
  }
}

function fresh(): {
  depth: Gauge<number>;
  name: Gauge<string>;
  span: Gauge<Span>;
  marks: Gauge<number[]>;
  either: Gauge<number | string>;
  inner: Gauge<Steady<boolean>>;
  ticker: Gauge<number>;
} {
  return {
    depth: new Steady<number>(4.5),
    name: new Steady<string>("north"),
    span: new Steady<Span>({ from: 1, to: 9 }),
    marks: new Steady<number[]>([3, 1, 2]),
    either: new Steady<number | string>("either"),
    inner: new Steady<Steady<boolean>>(new Steady<boolean>(true)),
    ticker: new Ticker(),
  };
}

function report(label: string, set: ReturnType<typeof fresh>): void {
  const inner = set.inner.latest;
  console.log(
    label,
    show(set.depth.latest),
    show(set.name.latest),
    show(set.span.latest),
    show(set.marks.latest),
    show(set.either.latest),
    inner === undefined ? "nothing" : `steady ${String(inner.level)}`,
    show(set.ticker.latest),
  );
}

{
  const set = fresh();
  report("before", set);
  sample(set.depth);
  sample(set.name);
  sample(set.span);
  sample(set.marks);
  sample(set.either);
  sample(set.inner);
  sample(set.ticker);
  report("function", set);
}

{
  // The other order: the first instance is the string one.
  const set = fresh();
  console.log(
    "kinds",
    kindOf(set.name),
    kindOf(set.depth),
    kindOf(set.span),
    kindOf(set.marks),
    kindOf(set.either),
    kindOf(set.inner),
    kindOf(set.ticker),
  );
}

{
  const set = fresh();
  const later = [sampleLater(set.span), sampleLater(set.depth), sampleLater(set.name)];
  report("closures made", set);
  for (const run of later) run();
  report("closures run", set);
}

{
  const set = fresh();
  console.log(
    "arrays",
    sampleAll([set.depth, set.ticker]),
    sampleAll([set.name]),
    sampleAll([set.marks]),
    sampleAll<Span>([]),
  );
  report("arrays", set);
}

{
  const set = fresh();
  console.log(
    "records",
    sampleHeld({ gauge: set.name, label: "name" }),
    sampleHeld({ gauge: set.depth, label: "depth" }),
    sampleHeld({ gauge: set.inner, label: "inner" }),
  );
  report("records", set);
}

{
  const set = fresh();
  const seen: string[] = [];
  sampleThen(set.depth, (gauge) => seen.push(show(gauge.latest)));
  sampleThen(set.name, (gauge) => seen.push(show(gauge.latest)));
  sampleThen(set.span, (gauge) => seen.push(show(gauge.latest)));
  console.log("callbacks", seen.join(" | "));
}

{
  const set = fresh();
  const none: Gauge<string> | null = null;
  console.log(
    "nullable",
    sampleIfAny(set.marks),
    sampleIfAny(set.name),
    sampleIfAny(none),
    sampleIfAny(set.depth),
  );
  report("nullable", set);
}

{
  const set = fresh();
  samplePair(set.depth, set.name);
  samplePair(set.name, set.depth);
  samplePair(set.span, set.span);
  samplePair(set.ticker, set.either);
  report("pairs", set);
}

{
  const set = fresh();
  sampleAs<number>(set.depth);
  sampleAs<string>(set.name);
  sampleAs<Span>(set.span);
  sampleAs<number[]>(set.marks);
  report("type argument only", set);
}

{
  const set = fresh();
  sampleArrow(set.name);
  sampleArrow(set.depth);
  sampleArrow(set.marks);
  report("arrow", set);
}

{
  const set = fresh();
  const station = new Station();
  station.sample(set.depth);
  station.sample(set.name);
  station.sample(set.span);
  Station.sample(set.either);
  Station.sample(set.marks);
  Station.sample(set.ticker);
  console.log("station", station.samples);
  report("methods", set);
}

{
  // Function values pinned to one signature each, then the function held
  // as an untyped value.
  const set = fresh();
  const forDepth: (gauge: Gauge<number>) => void = sample;
  const forName: (gauge: Gauge<string>) => void = sample;
  forName(set.name);
  forDepth(set.depth);
  forDepth(set.ticker);
  const held: unknown = sample;
  console.log("values", typeof held, forDepth === forDepth);
  report("values", set);
}
