// Spreading a value held as any that is not iterable throws V8's TypeError,
// which names the spread expression: `x is not iterable` for an identifier
// or property path (through parentheses and type assertions), and `f is not
// a function or its return value is not iterable` for a call of one.
function dyn(value: unknown): any {
  return value;
}
function sum(...values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
const obj = dyn({ a: 1 });
const holder = dyn({ inner: 5, list: [1, 2] });
const cases: [string, () => unknown][] = [
  ["identifier", () => [...obj]],
  ["property path", () => [...holder.inner]],
  ["call", () => [...dyn(7)]],
  ["parenthesized", () => [...(obj)]],
  ["asserted", () => [...(obj as any)]],
  ["null", () => [...dyn(null)]],
  ["undefined holder", () => [...holder.missing]],
  ["call argument", () => sum(...obj)],
  ["iterable", () => [...holder.list].join(",")],
];
for (const [label, run] of cases) {
  try {
    console.log(label, "|", String(run()));
  } catch (error) {
    console.log(label, "|", String(error));
  }
}
for (const [label, value] of [["for-of identifier", obj], ["for-of number", dyn(3)]] as [string, any][]) {
  try {
    for (const item of value) console.log(item);
  } catch (error) {
    console.log(label, "|", String(error));
  }
}
