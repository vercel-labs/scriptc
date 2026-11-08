// An `instanceof` test on a value whose type is a union with a class the
// compiler rejected (here: a class with a number-keyed index signature),
// against another class. The rejected class has no layout to test against:
// the test is refused by name where it stands, beside the class's own
// diagnostic, instead of ending the compiler. The same program with a
// `[key: string]: any` signature compiles (corpus 9365).
class Failure extends Error {
  status: number;
  [index: number]: unknown;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

class Entry {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

function lookup(name: string): Entry | Failure {
  if (name.startsWith("x")) return new Failure("not found", 404);
  return new Entry(name);
}

export function describe(name: string): string {
  const found = lookup(name);
  if (found instanceof Entry) return found.name;
  return "failure";
}

console.log(describe("a"));
