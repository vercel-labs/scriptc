/* Indexes an array without a guard. Under this project's own tsconfig
 * (strict, but noUncheckedIndexedAccess OFF — TypeScript's default) this
 * typechecks and compiles; the sibling indexed-strict fixture compiles the
 * SAME program under a tsconfig that turns the knob on and must fail
 * preflight — pinning that scriptc adopts the project's strictness in
 * both directions. */
const xs = [10, 20, 30];
const i = 1;
const picked = xs[i];
console.log(picked + 1);
// The element is the checker's plain number: a method call needs no guard,
// and a read past the end is still undefined at run time.
console.log(picked.toFixed(2), xs[i].toString(16));
console.log(xs[7] === undefined, String(xs[7]));
const record: Record<string, number> = { amount: 12.345 };
const key = "amount";
console.log(record[key].toFixed(2), record["missing"] === undefined);
const tuple: [number, number] = [1.5, 2.5];
const index: number = 1;
console.log(tuple[index].toFixed(2), tuple[index + 4] === undefined);
