// @requires-libnode
// A value typed by an island's declarations may still be a native value: an
// island alias annotating a native Map, Set, typed array or array, an island
// interface a native class implements, a string an island module exports.
// A member read or write on it follows the value: an island object's member
// goes through the bridge, and any other value takes the ordinary native
// read or write. A Map's `size`, a typed array's `length` and elements and a
// class's accessors have no stored property to look up at run time, so these
// used to throw "expected number at $, got undefined", "Cannot assign to
// read only property" or "Reflect.get called on non-object".
import {
  describe,
  makeBytes,
  makeGauge,
  makeMeta,
  makeNames,
  makeTable,
  makeTags,
  VERSION,
  type Bytes,
  type Gauge,
  type Meta,
  type Names,
  type Shelf,
  type Table,
  type Tags,
} from "member-pkg";

let calls = 0;
function next(): number {
  calls++;
  return calls;
}

// 1. Builtin accessor properties of native values in island-typed slots.
const table: Table = new Map([["a", 1]]);
const tags: Tags = new Set(["x", "y"]);
const bytes: Bytes = new Uint8Array([4, 5, 6]);
const names: Names = ["a", "b", "c"];
console.log(table.size, tags.size, bytes.length, bytes.byteLength, names.length);
console.log(bytes[1], bytes[next()], names[0], names[next()], names[9] === undefined);

// 2. Writes and compound writes of elements, and an array's length.
bytes[0] = 9;
bytes[1] += next();
bytes[2] = bytes[0] + bytes[1];
names[1] = "B";
names[2] += "!";
names.length = 2;
console.log(bytes[0], bytes[1], bytes[2], names.length, names[1], describe(names));

// 3. The same through a member of a native record, an optional chain, a
// computed key and a destructuring.
const shelf: Shelf = { table, tags, bytes, names };
const maybe: Table | undefined = shelf.table.size > 0 ? shelf.table : undefined;
const sizeKey = "size" as const;
const { length: nameCount } = shelf.names;
console.log(shelf.table.size, shelf.tags.size, shelf.bytes.length, maybe?.size, shelf.table[sizeKey], nameCount);

// 4. A native class instance behind the island's interface: its accessors
// run, through a binding and through a parameter that also receives an
// island object and a literal.
class Dial implements Gauge {
  private raw = 1;
  writes = 0;
  get level(): number {
    return this.raw * 10;
  }
  set level(value: number) {
    this.writes++;
    this.raw = value;
  }
  get label(): string {
    return "dial" + this.writes;
  }
}
const dial: Gauge = new Dial();
console.log(dial.level, dial.label);
dial.level = 3;
dial.level += next();
console.log(dial.level, dial.label);
function bump(gauge: Gauge, by: number): string {
  gauge.level = gauge.level + by;
  gauge.level += by;
  return gauge.label + ":" + gauge.level;
}
console.log(bump(new Dial(), next()), bump(makeGauge(), next()), bump({ level: 1, label: "literal" }, next()));

// 5. Either origin through one parameter, for the builtin members.
function measure(t: Table, s: Tags, b: Bytes, n: Names): string {
  return [t.size, s.size, b.length, b[0], n.length, n[0]].join(",");
}
console.log(measure(new Map(), new Set(["a"]), new Uint8Array(2), ["n"]));
console.log(measure(makeTable(), makeTags(), makeBytes(), makeNames()));
console.log(measure(table, makeTags(), bytes, makeNames()));

// 6. A string an island module exports, and members that are not there.
console.log(VERSION.length, VERSION);
const meta: Meta = { a: "1" };
const made = makeMeta();
console.log(meta["a"], meta["nope"] === undefined, made["made"], made["nope"] === undefined, meta.a, made.nope === undefined);

// 7. A missing receiver is Node's TypeError, whichever side would have made it.
function sizeOf(t: Table | undefined): number {
  return t!.size;
}
try {
  sizeOf(calls > 99 ? table : undefined);
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message);
}
