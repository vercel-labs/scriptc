import { inspect } from "node:util";

// Retained reachability lowers module inits before the function bodies they
// discover. Record metadata and every helper that snapshots it must still use
// historical emit order: these functions' {a,b} shapes precede the inits'
// structurally-equal {b,a} shapes.
function printFunctionRecord(): void {
  const value = { a: 1, b: 2 };
  console.log(Object.keys(value).join(","));
  console.log(Object.values(value).join(","));
  console.log(Object.entries(value).map(([k, v]) => `${k}:${v}`).join(","));
  console.log(JSON.stringify(value));
  console.log(inspect(value));
}

function printIndexRecord(): void {
  const value: { a: number; b: number; [key: string]: number } = { a: 1, b: 2 };
  console.log(Object.keys(value).join(","));
  console.log(Object.values(value).join(","));
  console.log(Object.entries(value).map(([k, v]) => `${k}:${v}`).join(","));
}

function printCapturedRecord(): void {
  const source = { a: 1, b: 2 };
  const value: Record<string, number> = source;
  console.log(Object.keys(value).join(","));
}

function printAssignedRecord(): void {
  const value: Record<string, unknown> = {};
  Object.assign(value, { a: 1, b: 2 });
  console.log(Object.keys(value).join(","));
}

function capturedCount(value: Record<string, number>): number {
  return Object.keys(value).length;
}

function assignedCount(): number {
  const value: Record<string, unknown> = {};
  Object.assign(value, { b: 2, a: 1 });
  return Object.keys(value).length;
}

interface OrderedNode {
  a: number;
  b: number;
  next: OrderedNode | null;
}

function printRecursiveRecord(): void {
  const value: OrderedNode = { a: 1, b: 2, next: null };
  value.next = value;
  console.log(inspect(value));
}

class GenericOrderedPair {
  genericFirst = 1;
  genericSecond = 2;
}

function genericSourceFirst<T>(_: T): void {
  // This rest lowering checks order immediately; a helper finalizer cannot
  // repair it after the wrong generic instance has already fenced.
  const { ...value } = new GenericOrderedPair();
  console.log(Object.keys(value).join(","));
}

function genericSourceSecond<T>(_: T): void {
  const value = { genericSecond: 2, genericFirst: 1 };
  console.log(Object.keys(value).length);
}

function callGenericSourceFirst(): void {
  genericSourceFirst(1);
}

function callGenericSourceSecond(): void {
  genericSourceSecond(1);
}

class GenericClassSourceFirst<T> {
  constructor(_: T) {
    const { ...value } = new GenericOrderedPair();
    console.log(Object.keys(value).join(","));
  }
}

class GenericClassSourceSecond<T> {
  constructor(_: T) {
    const value = { genericSecond: 2, genericFirst: 1 };
    console.log(Object.keys(value).length);
  }
}

function constructGenericClassSourceFirst(): void {
  new GenericClassSourceFirst(1);
}

function constructGenericClassSourceSecond(): void {
  new GenericClassSourceSecond(1);
}

class NestedGenericOrderedPair {
  nestedFirst = 1;
  nestedSecond = 2;
}

function nestedGenericInstanceSourceFirst<T>(_: T): void {
  const value = { nestedFirst: 1, nestedSecond: 2 };
  console.log(Object.keys(value).length);
}

function nestedGenericSourceFirst(): void {
  nestedGenericInstanceSourceFirst(1);
}

function genericReachesEarlierSource<T>(_: T): void {
  const value = { nestedSecond: 2, nestedFirst: 1 };
  console.log(Object.keys(value).length);
  // Reachability learns about this earlier declaration only while this
  // instance lowers. Its metadata must still settle before the rest-order
  // support decision becomes final.
  nestedGenericSourceFirst();
  const { ...rest } = new NestedGenericOrderedPair();
  console.log(Object.keys(rest).join(","));
}

function printPartialRecord<T extends { a: number; b: number }>(value: T): void {
  // Partial<T> derives a fresh shape from T. Its declaration order must
  // follow T when retained lowering later settles T to the earlier
  // printFunctionRecord body's {a,b} order.
  const partial = value as Partial<T>;
  console.log(Object.keys(partial).join(","));
}

console.log(Object.keys({ b: 2, a: 1 }).length);
console.log(Object.values({ b: 2, a: 1 }).length);
console.log(Object.entries({ b: 2, a: 1 }).length);
console.log(inspect({ b: 2, a: 1 }).length);
console.log(Object.keys({ b: 2, a: 1 } as { b: number; a: number; [key: string]: number }).length);
console.log(Object.values({ b: 2, a: 1 } as { b: number; a: number; [key: string]: number }).length);
console.log(Object.entries({ b: 2, a: 1 } as { b: number; a: number; [key: string]: number }).length);
console.log(capturedCount({ b: 2, a: 1 }));
console.log(assignedCount());
console.log(inspect({ b: 2, a: 1, next: null } as { b: number; a: number; next: OrderedNode | null }).length);
printPartialRecord({ a: 1, b: 2 });
// Runtime reachability encounters the second caller first. The historical
// emitter visited these caller bodies in source order before it drained the
// generic-instance queue, so the first instance owns the shared shape's key
// order.
callGenericSourceSecond();
callGenericSourceFirst();
constructGenericClassSourceSecond();
constructGenericClassSourceFirst();
genericReachesEarlierSource(1);

printFunctionRecord();
printIndexRecord();
printCapturedRecord();
printAssignedRecord();
printRecursiveRecord();
