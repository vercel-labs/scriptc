"use strict";

const numbers = [1];
numbers[-1] = 7;
const view: any = numbers;
console.log("promoted", numbers[-1], view[-1], Object.keys(view).join(","));
let gets = 0;
let sets = 0;
Object.defineProperty(view, "-1", {
  configurable: true,
  get: function(this: unknown): number {
    gets++;
    console.log("get receiver", this === view);
    return 11;
  },
  set: function(this: unknown, value: number): void {
    sets += value;
    console.log("set receiver", this === view);
  },
});
console.log("read once", numbers[-1], gets);
console.log("own presence", Object.hasOwn(numbers, -1), -1 in numbers, gets);
numbers[-1] = 3;
console.log("set", sets, gets);

Object.defineProperty(view, "-2", {
  configurable: true,
  get: function(): unknown { gets++; return undefined; },
});
console.log("undefined", numbers[-2], Object.hasOwn(numbers, -2), gets);
const marker: unknown = JSON.parse('{"failure":"named getter"}');
Object.defineProperty(view, "-3", {
  get: function(): never { throw marker; },
});
try { console.log(numbers[-3]); }
catch (error) { console.log("same getter error", error === marker); }

const prototype: any = JSON.parse("{}");
Object.defineProperty(prototype, "2", {
  get: function(this: unknown): number { gets++; console.log("inherited receiver", this === view); return 13; },
});
Object.setPrototypeOf(view, prototype);
const inheritedIndex = 2;
console.log("inherited presence", inheritedIndex in numbers, Object.hasOwn(numbers, inheritedIndex), gets);
console.log("inherited read", numbers[inheritedIndex], gets);

Object.defineProperty(view, "-4", {
  get: function(): unknown { gets++; return "x"; },
});
if (numbers[-4]) console.log("truthy string", gets);
Object.defineProperty(view, "-5", {
  get: function(): unknown { gets++; return "17"; },
  set: function(value: number): void { console.log("numeric setter", value); },
});
console.log("numeric update", numbers[-5]++, gets);
console.log("number constructor", Number(numbers[-5]), gets);
Object.defineProperty(view, "-6", {
  get: function(): unknown { return 31n; },
});
console.log("constructor bigint", Number(numbers[-6]));
try { console.log(+numbers[-6]); }
catch (error) { console.log("coercion bigint", error instanceof TypeError); }

Object.freeze(view);
numbers[-1] = 5;
console.log("frozen setter", sets, Object.isFrozen(numbers));
const throwing = [0];
const throwingView: any = throwing;
Object.defineProperty(throwingView, "-1", {
  set: function(): never { throw marker; },
});
Object.freeze(throwingView);
try { throwing[-1] = 9; }
catch (error) { console.log("same setter error", error === marker); }

let target = [0];
const originalTarget = target;
const orderedView: any = originalTarget;
Object.defineProperty(orderedView, "-1", {
  set: function(this: unknown, value: number): void { console.log("ordered setter", this === orderedView, value); },
});
Object.freeze(orderedView);
function writeKey(): number { console.log("write key"); target = [99]; return -1; }
function writeValue(): number { console.log("write rhs"); return 29; }
target[writeKey()] = writeValue();
console.log("write receiver", target[0], originalTarget[0]);

const shortCircuit = [0];
const shortView: any = shortCircuit;
let shortGets = 0;
Object.defineProperty(shortView, "-1", {
  get: function(): number { shortGets++; return 3; },
  set: function(value: number): void { console.log("short setter", value); },
});
shortCircuit[-1] ??= writeValue();
shortCircuit[-1] ||= writeValue();
console.log("short reads", shortGets);

let right = [3];
const left = [0];
const leftView: any = left;
Object.defineProperty(leftView, "-1", {
  get: function(): number { right = [19]; return 19; },
});
console.log("left before right", left[-1] === right[0]);

class Cell {
  value: number;
  constructor(value: number) { this.value = value; }
}
let cells = [new Cell(1)];
function exposeCells(values: Cell[]): void {
  const cellView: any = values;
  Object.defineProperties(cellView, { "-2": { value: new Cell(8), configurable: true } });
  const descriptor: any = Object.getOwnPropertyDescriptor(cellView, "-2");
  console.log("batch descriptor", descriptor.value.value, values[-2].value);
  Object.defineProperty(cellView, "-1", {
    get: function(): Cell { cells = [new Cell(99)]; return new Cell(23); },
  });
  const accessor: any = Object.getOwnPropertyDescriptor(cellView, "-1");
  console.log("accessor descriptor", typeof accessor.get, cells[0].value);
}
exposeCells(cells);
const fresh = cells[-1];
console.log("fresh lifetime", fresh.value, cells[0].value);
