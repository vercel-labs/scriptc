// A Map or Set that untyped code built, handed to a slot typed Map<K, V> or
// Set<T>, is one collection for both sides: the typed side reads and writes
// it, the untyped side sees those writes and its own, and both hold the same
// object. Pins the checked conversion of an untyped collection into a typed
// collection type for each place the type can stand and for the element
// types it has.

function invoke(callee: unknown, argument: unknown): unknown {
  if (typeof callee === "function") return callee(argument);
  return undefined;
}

class Seat {
  row: number;
  taken: boolean;
  constructor(row: number) {
    this.row = row;
    this.taken = false;
  }
}

interface Booking {
  guest: string;
  nights: number;
}

// The untyped side: nothing here names the types the typed side declares.
function tally(pairs: readonly (readonly [unknown, unknown])[]): unknown {
  const tallies = new Map<unknown, unknown>();
  for (const [key, value] of pairs) tallies.set(key, value);
  return tallies;
}

function roster(names: readonly unknown[]): unknown {
  const present = new Set<unknown>();
  for (const name of names) present.add(name);
  return present;
}

function untypedTally(): unknown {
  const tallies = new Map();
  tallies.set("north", 4);
  tallies.set("south", 6);
  return tallies;
}

function describeUntyped(value: unknown): string {
  if (value instanceof Map) {
    const parts: string[] = [];
    value.forEach((entry: unknown, key: unknown) => {
      parts.push(String(key) + ":" + String(entry));
    });
    return "Map(" + String(value.size) + ") " + parts.join(" ");
  }
  if (value instanceof Set) {
    const parts: string[] = [];
    value.forEach((entry: unknown) => {
      parts.push(String(entry));
    });
    return "Set(" + String(value.size) + ") " + parts.join(" ");
  }
  return "other";
}

// The typed side.
function total(counts: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const [, count] of counts) sum += count;
  return sum;
}

function shout(names: ReadonlySet<string>): string {
  return [...names].map((name) => name.toUpperCase()).join(",");
}

function viaMember(props: { readonly counts: ReadonlyMap<string, number>; readonly names: ReadonlySet<string> }): string {
  return String(total(props.counts)) + " " + shout(props.names);
}

function viaList(all: readonly Map<string, number>[]): string {
  return all.map((counts) => String(total(counts))).join("+");
}

function viaOptional(counts: Map<string, number> | undefined): string {
  return counts === undefined ? "none" : String(total(counts));
}

function viaUnion(value: Set<string> | string): string {
  return typeof value === "string" ? "text " + value : shout(value);
}

function pick(producer: unknown): unknown {
  return producer;
}

console.log("parameter", invoke(total, tally([["a", 1], ["b", 2]])));
console.log("parameter", invoke(shout, roster(["ada", "bo"])));
console.log("untyped builder", invoke(total, untypedTally()));
console.log("member", invoke(viaMember, { counts: tally([["a", 5]]), names: roster(["cy"]) }));
console.log("element", invoke(viaList, [tally([["a", 1]]), tally([["a", 2], ["b", 3]])]));
console.log("optional", invoke(viaOptional, tally([["a", 7]])), invoke(viaOptional, undefined));
console.log("union", invoke(viaUnion, roster(["di"])), invoke(viaUnion, "plain"));
console.log("cast", total(tally([["a", 8]]) as Map<string, number>));
const produce = pick(untypedTally) as () => Map<string, number>;
console.log("return", total(produce()));
console.log("empty", invoke(total, tally([])), invoke(shout, roster([])));

// Key and value types.
function numberKeys(byId: Map<number, string>): string {
  let out = "";
  for (const [id, label] of byId) out += String(id + 1) + label;
  return out;
}
function flags(byName: Map<string, boolean>): string {
  let out = "";
  for (const [name, on] of byName) out += name + (on ? "+" : "-");
  return out;
}
function mixed(byName: Map<string, number | string>): string {
  let out = "";
  for (const [name, value] of byName) out += name + (typeof value === "number" ? String(value * 2) : value);
  return out;
}
function loose(byName: Map<string, unknown>): string {
  let out = "";
  for (const [name, value] of byName) out += name + typeof value;
  return out;
}
function seats(byName: Map<string, Seat>): string {
  let out = "";
  for (const [name, seat] of byName) {
    seat.taken = true;
    out += name + String(seat.row);
  }
  return out;
}
function seatSet(all: Set<Seat>): number {
  let rows = 0;
  for (const seat of all) rows += seat.row;
  return rows;
}
function bySeat(names: Map<Seat, string>): string {
  let out = "";
  for (const [seat, name] of names) out += name + String(seat.row);
  return out;
}
function bookings(byRoom: Map<string, Booking>): string {
  let out = "";
  for (const [room, booking] of byRoom) {
    booking.nights += 1;
    out += room + booking.guest + String(booking.nights);
  }
  return out;
}
function nested(byFloor: Map<string, Map<string, number>>): number {
  let sum = 0;
  for (const [, rooms] of byFloor) sum += total(rooms);
  return sum;
}
function lists(byDay: Map<string, number[]>): string {
  let out = "";
  for (const [day, values] of byDay) {
    values.push(0);
    out += day + String(values.length);
  }
  return out;
}

const front = new Seat(1);
const back = new Seat(9);
console.log("number keys", invoke(numberKeys, tally([[1, "x"], [2, "y"]])));
console.log("boolean values", invoke(flags, tally([["a", true], ["b", false]])));
console.log("union values", invoke(mixed, tally([["a", 2], ["b", "z"]])));
console.log("unknown values", invoke(loose, tally([["a", 2], ["b", "z"]])));
console.log("class values", invoke(seats, tally([["f", front], ["b", back]])), front.taken, back.taken);
console.log("class members", invoke(seatSet, roster([front, back])));
console.log("class keys", invoke(bySeat, tally([[front, "f"], [back, "b"]])));
const decoded = tally([["r1", JSON.parse('{"guest":"eve","nights":2}')]]);
console.log("decoded record values", invoke(bookings, decoded), JSON.stringify((decoded as Map<unknown, unknown>).get("r1")));
const inner = tally([["101", 2], ["102", 3]]);
const outer = tally([["first", inner]]);
console.log("nested maps", invoke(nested, outer), (outer as Map<unknown, unknown>).get("first") === inner);
const days = tally([["mon", JSON.parse("[1,2]")]]);
console.log("decoded array values", invoke(lists, days), JSON.stringify((days as Map<unknown, unknown>).get("mon")));

// After the crossing: one object, writes seen by both sides.
let kept: Map<string, number> | undefined;
function keep(counts: Map<string, number>): Map<string, number> {
  kept = counts;
  return counts;
}
const original = tally([["a", 1], ["b", 2]]);
const returned = invoke(keep, original);
console.log("identity", returned === original, invoke(keep, original) === returned);
if (kept !== undefined) {
  kept.set("c", 3);
  kept.delete("a");
  console.log("typed write seen by the untyped side", describeUntyped(original));
  (original as Map<unknown, unknown>).set("d", 4);
  console.log("untyped write seen by the typed side", kept.get("d"), kept.size, total(kept));
  console.log("read", kept.get("b"), kept.get("zzz"), kept.has("c"), [...kept.keys()].join(","));
}
function readonlyView(counts: ReadonlyMap<string, number>): unknown {
  return counts;
}
console.log("a second view of the same type is the same object", invoke(readonlyView, original) === original);
function untypedView(counts: Map<unknown, unknown>): number {
  return counts.size;
}
console.log("an untyped view after the typed one", invoke(untypedView, original));

let keptNames: Set<string> | undefined;
function keepNames(names: Set<string>): Set<string> {
  keptNames = names;
  return names;
}
const people = roster(["ada", "bo"]);
console.log("identity", invoke(keepNames, people) === people);
if (keptNames !== undefined) {
  keptNames.add("cy");
  keptNames.delete("ada");
  console.log("typed write seen by the untyped side", describeUntyped(people));
  (people as Set<unknown>).add("di");
  console.log("untyped write seen by the typed side", keptNames.has("di"), keptNames.size, shout(keptNames));
}

// A crossing inside a loop over the source, and after an entry was removed.
const looped = tally([["a", 1], ["b", 2], ["c", 3]]) as Map<unknown, unknown>;
let seen = "";
for (const [key] of looped) {
  seen += String(key) + String(invoke(total, looped)) + ";";
  if (key === "a") looped.set("d", 4);
}
console.log("crossing during iteration", seen);
const pruned = tally([["a", 1], ["b", 2], ["c", 3]]) as Map<unknown, unknown>;
pruned.delete("a");
console.log("crossing after a removal", invoke(total, pruned), describeUntyped(pruned));
let after = "";
for (const [key] of pruned) after += String(key);
console.log("untyped iteration after", after);

// An entry that holds plain objects and arrays of its own, at depth, is one
// entry for both sides. What it holds under a member typed unknown may be
// held elsewhere too: nothing there is converted.
interface Stay {
  room: number;
  guests: string[];
  host: { name: string; visits: number[] };
  note: unknown;
}
const remark: unknown = JSON.parse('["late"]');
function stays(): unknown {
  const stay: any = JSON.parse('{"room":4,"guests":["ada"],"host":{"name":"bo","visits":[1]}}');
  stay.note = remark;
  const byGuest = new Map<unknown, unknown>();
  byGuest.set("ada", stay);
  return byGuest;
}
function extend(byGuest: Map<string, Stay>): string {
  const stay = byGuest.get("ada");
  if (stay === undefined) return "none";
  stay.guests.push("cy");
  stay.host.visits.push(stay.host.visits.length + 1);
  return stay.guests.join("+") + " " + stay.host.name + " " + stay.host.visits.join("+") + " " + String(stay.note === remark);
}
const lodging = stays();
console.log("an entry with members of its own", invoke(extend, lodging));
console.log("seen by the untyped side", JSON.stringify((lodging as Map<unknown, unknown>).get("ada")));
console.log("the same entry again", invoke(extend, lodging));
console.log("held under an unknown member", JSON.stringify(remark));
