// A Map of compact class instances (ProgramLifetime values in a low-region
// build) is iterated without any keyed read: the compact iteration step
// needs the compact map-entry helper, whose runtime probe must be declared
// even though no read-by-key emits a use of it.
import type { ProgramLifetime } from "@scriptc/types";

class Item implements ProgramLifetime {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

const m = new Map<string, Item>();
for (let i = 0; i < 6; i++) m.set("k" + i, new Item("v" + i));
let sum = 0;
for (const [k, v] of m) sum += k.length + v.name.length;
for (const v of m.values()) sum += v.name.length;
console.log(sum, m.size);
