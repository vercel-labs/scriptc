// Holes written through an `unknown[]` or `any` view of a typed array are
// holes of the typed array: for...of visits them as undefined and the find
// family passes them to its callback, as in Node. The views reach the array
// through a binding, an `any` parameter, a generic instantiated with
// `unknown`, a record field, a class field and a nested array.

const numbers: number[] = [1, 2];
const numbersView: unknown[] = numbers;
numbersView[3] = 5;
for (const value of numbers) console.log("numbers", value, typeof value);
console.log(numbers.findIndex((value) => value === undefined));
console.log(numbers.findLastIndex((value) => value === undefined));
console.log(numbers.find((value) => value !== undefined && value > 1));

const grown: string[] = ["a"];
const grownView: unknown[] = grown;
grownView.length = 3;
for (const value of grown) console.log("grown", value);

function growAny(values: any): void {
  values[2] = 9;
}
const passed: number[] = [7];
growAny(passed);
for (const value of passed) console.log("passed", value);

function keep<T>(value: T): T {
  return value;
}
const kept: number[] = [3];
(keep<unknown>(kept) as unknown[])[2] = 4;
for (const value of kept) console.log("kept", value);

const boxed: number[] = [1];
const box: unknown = { values: boxed };
(box as { values: unknown[] }).values[2] = 3;
for (const value of boxed) console.log("boxed", value);

class Holder {
  values: number[] = [1, 2];
}
const holder = new Holder();
const holderView: unknown = holder;
(holderView as { values: unknown[] }).values[3] = 4;
for (const value of holder.values) console.log("holder", value);

const nested: number[][] = [[1]];
const nestedView: unknown[][] = nested;
nestedView[0]![2] = 3;
for (const value of nested[0]!) console.log("nested", value);

// A named property written through a view is not an element.
const named: number[] = [1, 2];
const bag = named as unknown as Record<string, unknown>;
bag["label"] = "x";
for (const value of named) console.log("named", value);
console.log(named.length, bag["label"]);

// Views that reach dynamic code through class field initializers,
// parameter defaults, logical assignments, yield and throw, and through
// standard library calls that keep their argument or pass it to a
// callback: Promise.resolve, push onto an `unknown[]`, Map.prototype.set
// and a JSON.stringify replacer.
const fieldNumbers: number[] = [1, 2];
class FieldView {
  view: unknown[] = fieldNumbers;
}
new FieldView().view[3] = 4;
for (const value of fieldNumbers) console.log("field", value);
const defaultNumbers: number[] = [1];
function extend(view: unknown[] = defaultNumbers): void {
  view.length = 3;
}
extend();
console.log(defaultNumbers.findIndex((value) => value === undefined), defaultNumbers.length);
let assigned: unknown[] | undefined;
const assignedNumbers: number[] = [5];
assigned ??= assignedNumbers;
assigned[2] = 6;
for (const value of assignedNumbers) console.log("assigned", value);
const yieldedNumbers: number[] = [7];
function* yieldViews(): Generator<unknown[]> {
  yield yieldedNumbers;
}
for (const view of yieldViews()) view[2] = 8;
console.log(yieldedNumbers.findLastIndex((value) => value === undefined), yieldedNumbers.length);
const thrownNumbers: number[] = [9];
try {
  throw thrownNumbers;
} catch (error) {
  (error as unknown[])[2] = 10;
}
for (const value of thrownNumbers) console.log("thrown", value);
const retainedNumbers: number[] = [12];
const retained: unknown[] = [];
retained.push(retainedNumbers);
(retained[0] as unknown[])[2] = 13;
for (const value of retainedNumbers) console.log("kept", value);
const mappedNumbers: number[] = [14];
const byName = new Map<string, unknown>();
byName.set("a", mappedNumbers);
(byName.get("a") as unknown[])[2] = 15;
console.log(mappedNumbers.findIndex((value) => value === undefined), mappedNumbers.length);
const replacedNumbers: number[] = [16];
JSON.stringify({ replacedNumbers: replacedNumbers }, (key, value: unknown) => {
  if (key === "replacedNumbers") (value as unknown[])[2] = 17;
  return value;
});
for (const value of replacedNumbers) console.log("replaced", value);
const resolvedNumbers: number[] = [11];
void Promise.resolve<unknown>(resolvedNumbers).then((view) => {
  (view as unknown[])[2] = 18;
  for (const value of resolvedNumbers) console.log("resolved", value);
});

