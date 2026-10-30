"use strict";

// A mutable type assertion is legal TypeScript. It must not erase the
// runtime integrity of the original fresh literal.
function writeRecord(value: { count: number }): void {
  value.count = 7;
}

const record = Object.freeze({ count: 42 }) as { count: number };
try {
  writeRecord(record);
  console.log("record write allowed");
} catch (error) {
  console.log("record", (error as Error).name);
}
console.log("record value", record.count);

const values = Object.freeze([1, 2]) as number[];
try {
  values[0] = 7;
  console.log("array write allowed");
} catch (error) {
  console.log("array", (error as Error).name);
}
console.log("array value", values[0], values.length);

const shallow = Object.freeze({ child: { count: 1 } });
shallow.child.count = 2;
console.log("shallow", shallow.child.count);
