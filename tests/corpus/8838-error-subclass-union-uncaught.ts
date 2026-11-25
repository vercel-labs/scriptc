// @exit: 1
// An uncaught instance of a program class that extends a builtin error
// class, thrown from a union-typed value, exits 1 with the output before the
// throw intact. stderr differs by design (SEMANTICS.md divergence 11) and is
// not compared; tests/harness/errors.test.ts pins the native line.
class Plain extends Error {}
class Fixed extends RangeError {}
const list = [new Plain("p"), new Fixed("out of range")];
for (const error of list) console.log(error.name, error.message);
throw list[1]!;
