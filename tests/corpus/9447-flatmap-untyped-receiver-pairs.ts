// flatMap on an untyped array in TypeScript, the callback returning a
// one-pair array or an empty array, and a value or an array: the call runs
// the runtime's flatMap with the callback boxed, and the result stays a
// checked-dynamic array.
const rows: any = JSON.parse(
  '[{"name":"small","code":"s"},{"name":"large","code":"l"},{"name":"custom"}]',
);
const pairs = rows.flatMap((row: any) => (row.code ? [[row.code, row.name]] : []));
console.log(JSON.stringify(pairs), pairs.length);
const byCode = Object.fromEntries(pairs);
console.log(byCode.s, byCode.l, byCode.x, Object.keys(byCode).join(","));

const widths: any = JSON.parse("[1,2,3,4]");
const mixed = widths.flatMap((n: number) => (n % 2 ? n : [n, n * 10]));
console.log(JSON.stringify(mixed));

// A receiver that is not an array throws Node's TypeError.
const notList: any = JSON.parse('{"flatMap":1}');
try {
  notList.flatMap((n: number) => (n ? [n] : []));
} catch (problem) {
  console.log(problem instanceof TypeError, (problem as Error).message);
}
