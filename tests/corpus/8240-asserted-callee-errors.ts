// A non-null assertion is erased in JavaScript, so calling an asserted callee
// that holds undefined throws the call's own TypeError, with V8's spelling of
// the callee: element keys, literal keys as names, parentheses and asserted
// links dropped, call results as f(...).
type F = (x: number) => number;
const table: Record<string, F> = { inc: (x) => x + 1 };
const obj: { cb?: F; inner?: { cb?: F } } = { inner: {} };
const arr: (F | undefined)[] = [undefined];
let maybe: F | undefined;
function get(): F | undefined { return undefined; }
const key = process.argv.length > 99 ? "inc" : "missing";
const cases: [string, () => number][] = [
  ["computed", () => table[key]!(1)],
  ["literal key", () => table["missing"]!(1)],
  ["dotted", () => obj.cb!(1)],
  ["nested", () => obj.inner!.cb!(1)],
  ["element", () => arr[0]!(1)],
  ["local", () => maybe!(1)],
  ["parens", () => (table[key])!(1)],
  ["call result", () => get()!(1)],
  ["parens outside", () => (table[key]!)(1)],
];
for (const [name, run] of cases) {
  try { console.log(name, run()); } catch (e) { console.log(name, (e as Error).name + ": " + (e as Error).message); }
}
