// A value in a NoInfer<T> position is a T: the callee reads it at T, and a
// write through that read reaches the caller's own value.
interface Reading {
  sensor: number;
  unit: string;
  note?: string;
}

class Probe {
  taken = 0;
  take(): number {
    return ++this.taken;
  }
}

function describe(r: Reading): string {
  const text = r.sensor + "/" + r.unit + "/" + r.note;
  r.unit = r.unit + "'";
  return text;
}

function describeAll(rs: Reading[]): string {
  const text = rs.map((r) => r.sensor + r.unit).join(",");
  rs.push({ sensor: rs.length + 1, unit: "x" });
  return text;
}

function describeEither(v: Reading | string): string {
  if (typeof v === "string") return v.toUpperCase();
  v.note = "seen";
  return v.sensor + v.unit;
}

// A parameter, a property, an element, an optional parameter, a result.
function twice<P>(reader: (value: P) => string, value: NoInfer<P>): string {
  return reader(value) + " | " + reader(value);
}
function boxed<P>(reader: (value: P) => string, box: { value: NoInfer<P> }): string {
  return reader(box.value) + " | " + reader(box.value);
}
function each<P>(reader: (value: P) => string, values: NoInfer<P>[]): string {
  return values.map((value) => reader(value)).join(" | ");
}
function maybe<P>(reader: (value: P) => string, value?: NoInfer<P>): string {
  return value === undefined ? "nothing" : reader(value);
}
function made<P>(make: () => P): NoInfer<P> {
  return make();
}
function fixed(value: NoInfer<Reading>): string {
  return describe(value) + " | " + describe(value);
}

// A member of a generic class, and a value that rests in an untyped slot
// before its reader takes it back.
class Station<P> {
  reader: (value: P) => string;
  value: NoInfer<P>;
  constructor(reader: (value: P) => string, value: NoInfer<P>) {
    this.reader = reader;
    this.value = value;
  }
  read(): string {
    return this.reader(this.value);
  }
}
class Shelf {
  reader: (value: any) => string;
  value: unknown;
  constructor(reader: (value: any) => string, value: unknown) {
    this.reader = reader;
    this.value = value;
  }
}
function shelve<P>(reader: (value: P) => string, value: NoInfer<P>): Shelf {
  return new Shelf(reader, value);
}

const reading: Reading = { sensor: 1, unit: "C" };
console.log(twice(describe, reading));
console.log(JSON.stringify(reading));
console.log(twice(describe, { sensor: 2, unit: "F", note: "roof" }));
console.log(fixed(reading), JSON.stringify(reading));
console.log(boxed(describe, { value: reading }), reading.unit);
console.log(each(describe, [reading, { sensor: 3, unit: "K" }]), reading.unit);
console.log(maybe(describe), maybe(describe, reading), reading.unit);

const batch: Reading[] = [{ sensor: 4, unit: "P" }];
console.log(twice(describeAll, batch), batch.length);
console.log(twice(describeAll, [{ sensor: 5, unit: "Q" }]));

const either: Reading | string = { sensor: 6, unit: "R" };
console.log(twice(describeEither, either), JSON.stringify(either));
console.log(twice(describeEither, "plain"));

const probe = new Probe();
console.log(twice((p: Probe) => String(p.take()), probe), probe.taken);
console.log(twice((n: number) => String(n + 1), 41), twice((s: string) => s + s.length, "s"));
console.log(twice((f: (n: number) => number) => String(f(4)), (n: number) => n * 2));

const back: Reading = made<Reading>(() => ({ sensor: 7, unit: "S" }));
console.log(describe(back), describe(back));

const station = new Station(describe, reading);
console.log(station.read(), station.read(), reading.unit, station.value === reading);

const shelf = shelve(describe, { sensor: 8, unit: "T" });
console.log(shelf.reader(shelf.value), shelf.reader(shelf.value), JSON.stringify(shelf.value));
const kept = shelve(describe, reading);
console.log(kept.reader(kept.value), kept.value === reading, reading.unit);
