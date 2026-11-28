/* The SAME program as indexed-loose, under a tsconfig that turns
 * noUncheckedIndexedAccess ON: an element read is `T | undefined` here, so
 * the unguarded arithmetic and method calls must FAIL preflight with the
 * checker's own "possibly 'undefined'" diagnostic (SC0001, never the
 * standard-library SC2012 fence) — the project's strictness is honored even
 * where scriptc's own defaults would have let it through. */
const xs = [10, 20, 30];
const i = 1;
const picked = xs[i];
console.log(picked + 1);
// Under the option every element read is `T | undefined`, so each method
// call below is a preflight error and a read past the end is that same
// undefined at run time.
console.log(picked.toFixed(2), xs[i].toString(16));
console.log(xs[7] === undefined, String(xs[7]));
const record: Record<string, number> = { amount: 12.345 };
const key = "amount";
console.log(record[key].toFixed(2), record["missing"] === undefined);
const tuple: [number, number] = [1.5, 2.5];
const index: number = 1;
console.log(tuple[index].toFixed(2), tuple[index + 4] === undefined);
