// SC6014 from the key-order pass: record types whose key order the program
// observes and whose values create their keys in an order the compiler does
// not follow. Each type is reported once, at a construction its order
// depends on. The first two types are reported; the others report nothing.

// A spread that also sets an optional key its source lacks, in a type whose
// literals list the keys in two orders.
interface Plot {
  crop: string;
  rows?: number;
  shade?: string;
}
const bed: Plot = { crop: "rye", shade: "half" };
const sown: Plot = { ...bed, rows: 4 };
const fallow: Plot = { crop: "none", rows: 0, shade: "full" };
console.log(Object.keys(sown).join(","), Object.keys(fallow).join(","));

// Object.assign adding two optional keys from a source whose own key order
// is only known when the program runs.
interface Hive {
  site: string;
  frames?: number;
  queen?: string;
}
const hive: Hive = { site: "north" };
const found: { frames?: number; queen?: string } = JSON.parse('{"queen":"marked","frames":10}');
Object.assign(hive, found);
console.log(JSON.stringify(hive));

// Object.assign from an object literal: the keys arrive in the literal's
// order, so nothing differs.
interface Skep {
  site: string;
  combs?: number;
  straw?: string;
}
const skep: Skep = { site: "south" };
Object.assign(skep, { straw: "rye", combs: 7 });
console.log(JSON.stringify(skep));

// Two optional keys assigned in an order that depends on the path taken:
// each value records the order it took, so nothing differs.
interface Kiln {
  fuel: string;
  cone?: number;
  hours?: number;
}
function fire(kiln: Kiln, slow: boolean): void {
  if (slow) {
    kiln.hours = 12;
    kiln.cone = 6;
  } else {
    kiln.cone = 10;
    kiln.hours = 8;
  }
}
const kiln: Kiln = { fuel: "wood" };
fire(kiln, process.argv.length < 9);
for (const key in kiln) console.log(key);

// One order for every value: nothing to report.
interface Loom {
  warp: string;
  weft?: string;
}
const loom: Loom = { warp: "linen" };
loom.weft = "wool";
console.log(Object.keys(loom).join(","));

// Different orders, each literal lists its own keys: every value records its
// order, so nothing differs.
interface Sieve {
  mesh: number;
  frame?: string;
}
const fine: Sieve = { mesh: 80, frame: "ash" };
const coarse: Sieve = { frame: "oak", mesh: 8 };
console.log(JSON.stringify(fine), JSON.stringify(coarse));

// The order is never observed: nothing to report.
interface Vat {
  dye: string;
  mordant?: string;
  rinse?: string;
}
const vat: Vat = { dye: "indigo" };
Object.assign(vat, { rinse: "cold", mordant: "alum" });
console.log(vat.dye, vat.rinse, vat.mordant);

// A clone of a literal-built source that adds optional keys the source
// lacks: Node appends them after the source's own keys, which the literal
// fixed, so the result's order is known and nothing is reported.
interface Dial {
  host: string;
  port?: number;
  secure?: boolean;
}
const base: Dial = { host: "localhost" };
const tuned: Dial = { ...base, port: 8080, secure: true };
console.log(Object.keys(tuned).join(","));

// Clone overrides run in the order the clone is written, so a source that
// lacks them takes that order, not the declaration order.
interface Tip {
  id: string;
  low?: number;
  high?: number;
}
const seed: Tip = { id: "x" };
const tipped: Tip = { ...seed, high: 9, low: 1 };
console.log(Object.keys(tipped).join(","));

// A delete takes back a key the literal wrote: the clone's override appends
// it after the keys the value has left, so the type's order cannot be
// followed and the type is reported.
interface Strand {
  id: string;
  a?: number;
}
const strand: Strand = { a: 1, id: "x" };
delete strand.a;
const knotted: Strand = { ...strand, a: 2 };
console.log(JSON.stringify(knotted));
