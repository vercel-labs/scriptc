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

printFunctionRecord();
printIndexRecord();
printCapturedRecord();
printAssignedRecord();
printRecursiveRecord();
