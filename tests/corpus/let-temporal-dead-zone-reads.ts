// A `let`, `const` or class read by a function that runs before the
// declaration does is in its temporal dead zone: Node throws a
// ReferenceError. After the declaration runs, a `let` declared without an
// initializer holds undefined.

function attempt(label: string, f: () => unknown): void {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, "threw", e instanceof ReferenceError ? "ReferenceError" : "other");
  }
}

function readLate(): number {
  return late;
}
attempt("let before", readLate);
let late: number = 5;
attempt("let after", readLate);

function readConstant(): string {
  return constant;
}
attempt("const before", readConstant);
const constant: string = "k";
attempt("const after", readConstant);

function readUnset(): number {
  return unset;
}
attempt("unset before", readUnset);
let unset: number;
attempt("unset declared", () => String(readUnset()));
unset = 3;
attempt("unset assigned", readUnset);

function inner(): void {
  const peek = (): number => x;
  attempt("local before", peek);
  let x: number = 7;
  attempt("local after", peek);
}
inner();

function readClass(): number {
  return Late.v;
}
attempt("class before", readClass);
class Late {
  static v = 2;
}
attempt("class after", readClass);
