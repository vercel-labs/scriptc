// A union arm that fits several arms of the destination union enters the arm
// its own discriminant names, and is copied into that arm's layout. Node
// keeps one object, so that conversion compiles where a program cannot tell
// the copy from it: both names are only read, or nothing else holds the
// value that is converted.

// Read on both sides. `Crate` lacks the discriminant, so the source union
// keeps none; `Stored` takes `Shipped` by width, so each arm fits two arms
// of `Tracked`.
type Crate = { weight: number };
type Stored = { place: "stored"; shelf?: number };
type Shipped = { place: "shipped"; carrier: string; days: number };
type Parcel = Stored | Shipped;
type Tracked = Parcel & { scanned?: boolean; note?: string };

function label(parcel: Tracked): string {
  const marks = (parcel.scanned ? "scanned" : "unscanned") + ("note" in parcel ? " noted" : "");
  if (parcel.place === "shipped")
    return `shipped by ${parcel.carrier} in ${parcel.days} (${marks})`;
  return `stored on ${parcel.shelf ?? "the floor"} (${marks})`;
}

const dock: (Crate | Parcel)[] = [
  { weight: 12 },
  { place: "stored", shelf: 3 },
  { place: "stored" },
  { place: "shipped", carrier: "rail", days: 2 },
];

function track(item: Crate | Parcel): Tracked | null {
  if ("place" in item) return item;
  return null;
}

for (const item of dock) {
  const tracked = track(item);
  console.log(tracked === null ? "crate" : label(tracked), JSON.stringify(item));
}

for (const item of dock) {
  if (!("place" in item)) continue;
  const tracked: Tracked = item;
  console.log(label(tracked), Object.keys(tracked).join(","), item.place);
}

// A value nothing else holds: the operand of the conversion is the call
// that builds it. The program writes through the result, and no other name
// can miss the write.
type ByZone = { by: "zone"; value: string };
type ByField = { by: "carrier" | "weight"; field: string; value?: string };
type Filter = ByZone | ByField;
type Draft = { by: string; field?: string; value?: unknown };

function draft(n: number): Draft | undefined {
  if (n === 0) return { by: "zone", value: "north" };
  if (n === 1) return { by: "carrier", field: "name", value: "rail" };
  return { by: "weight", field: "max" };
}

function fill(n: number): string {
  const filter = draft(n) as Filter;
  if (filter.by !== "zone" && filter.value === undefined) filter.value = "any";
  return filter.by === "zone"
    ? `zone=${filter.value}`
    : `${filter.by}.${filter.field}=${filter.value}`;
}

for (let n = 0; n < 3; n++) console.log(n, fill(n));

// An arm with exactly one destination arm is copied as well, and a program
// that writes another value of the destination's layout keeps compiling:
// the converted value is only read here.
type Rain = { kind: "rain"; mm: number };
type Wind = { kind: "wind"; knots: number };
type Reading = Rain | Wind;
type Logged = Reading & { station?: string };

const baseline: Logged = { kind: "wind", knots: 4 };
baseline.station = "pier";

function logged(entry: string | Reading): Logged | null {
  return typeof entry === "string" ? null : entry;
}

const entries: (string | Reading)[] = ["calm", { kind: "rain", mm: 7 }, { kind: "wind", knots: 21 }];
for (const entry of entries) {
  const kept = logged(entry);
  if (kept === null) console.log("skipped", entry);
  else console.log(kept.kind, kept.station ?? "no station", JSON.stringify(entry));
}
console.log(baseline.kind, baseline.station);
