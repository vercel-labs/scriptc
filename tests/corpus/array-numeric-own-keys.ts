export {};

const values = new Array<number | undefined>(4);
values[0] = 12;
values[2] = undefined;
function present(index: number): boolean { return Object.hasOwn(values, index); }
for (const index of [0, 1, 2, 3, 4, -0, -1, 1.5, NaN, Infinity, 4294967295]) {
  console.log("initial", index, present(index));
}
for (const index of [-1, 1.5, NaN, Infinity, -Infinity, 4294967295, 4294967296]) {
  values[index] = undefined;
  console.log("property", index, present(index));
}
values.length = 1;
values.length = 4;
console.log("regrown", present(2), present(3));
console.log("record", Object.hasOwn({ value: 1 }, "value"), Object.hasOwn({ value: 1 }, "missing"));

function replaced(): boolean {
  let items = [1];
  return Object.hasOwn(items, (items = [], 0));
}
console.log("replaced", replaced());
let captured = [1];
function replaceCaptured(): number { captured = []; return 0; }
console.log("captured", Object.hasOwn(captured, replaceCaptured()), captured.length);
const holder = { items: [1] };
function replaceField(): number { holder.items = []; return 0; }
console.log("field", Object.hasOwn(holder.items, replaceField()), holder.items.length);
let order = "";
function receiver(): number[] { order += "R"; return [1]; }
function key(): number { order += "K"; return 0; }
console.log("order", Object.hasOwn(receiver(), key()), order);
function throwingKey(): number { order += "T"; throw new Error("key"); }
try { Object.hasOwn(receiver(), throwingKey()); }
catch (error) { console.log("throw", (error as Error).message, order); }
const mutated = [1];
function removeSlot(): number { mutated.length = 0; return 0; }
console.log("mutated", Object.hasOwn(mutated, removeSlot()));
