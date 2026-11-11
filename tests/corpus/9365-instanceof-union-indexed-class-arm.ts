// An `instanceof` test on a value whose type is a union with a class that
// declares an index signature, against the other class and against the
// class itself; the indexed arm's own and added properties read through
// the narrowed value.
class Absent extends Error {
  depth: number;
  [key: string]: any;
  constructor(what: string, depth: number) {
    super(what);
    this.depth = depth;
    this.tried = what.toUpperCase();
  }
}

class Entry {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

function lookup(name: string): Entry | Absent {
  if (name.startsWith("x")) return new Absent("no such entry", 2);
  return new Entry(name);
}

export function describe(name: string): string {
  const found = lookup(name);
  if (found instanceof Entry) return found.name;
  return `absent ${found.depth} ${found.tried} ${found.message} ${found.missing}`;
}

function depthOf(value: Entry | Absent): number {
  return value instanceof Absent ? value.depth : 0;
}

console.log(describe("a"), describe("xyz"));
console.log(depthOf(lookup("a")), depthOf(lookup("x")), lookup("x") instanceof Error, lookup("a") instanceof Absent);
