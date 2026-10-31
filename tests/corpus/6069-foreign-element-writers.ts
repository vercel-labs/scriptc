// Values of other types written into typed arrays by code that sees them as
// `any` or `unknown[]`: an `any` parameter, a record field, methods that
// reorder the whole array through the view, and an `unknown[]` parameter. The typed
// array keeps every written value, and the view reads them back.

function label(values: any): void {
  values.push("label");
  values[0] = "first";
}
const labelled: number[] = [1, 2];
label(labelled);
console.log(labelled, labelled.length, JSON.stringify(labelled));

interface Box {
  values: unknown[];
}
const boxed: number[] = [1, 2, 3];
const box: Box = { values: boxed };
box.values[1] = "two";
box.values.push(null);
console.log(boxed, box.values === boxed);

// reverse and sort through the view rewrite the typed array.
const filled: number[] = [1, 2, 3, 4];
const filledView: unknown[] = filled;
filledView[1] = "z";
filledView[2] = "z";
console.log(filled);
filledView.reverse();
console.log(filled, filled[0], filled[3]);
filledView.sort();
console.log(filled);

function setAt(values: unknown[], index: number, value: unknown): void {
  values[index] = value;
}
const assigned: number[] = [1, 2];
setAt(assigned, 1, "b");
setAt(assigned, 3, "d");
console.log(assigned, assigned.length);

// The view's own methods and iteration see the same elements.
const shared: number[] = [1, 2];
const sharedView: unknown[] = shared;
sharedView.push("x");
console.log(sharedView.map((value) => typeof value).join(","));
console.log(sharedView.filter((value) => typeof value === "number").length);
for (const value of sharedView) console.log("view", value);
for (const key in shared) console.log("key", key);
console.log(Object.keys(sharedView), sharedView.indexOf("x"), sharedView.includes("x"));

// Writing a number through the view stores an ordinary element.
sharedView[2] = 3;
console.log(shared, shared[2] + 1);
