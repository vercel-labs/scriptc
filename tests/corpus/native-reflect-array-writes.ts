"use strict";

const numbers = [1, 2];
const numberView: any = numbers;
console.log("native index", Reflect.set(numberView, "0", 9), numbers[0]);
console.log("native length", Reflect.set(numberView, "length", 1), numbers.length);
const strings = ["before"];
const stringView: any = strings;
console.log("native reference", Reflect.set(stringView, "0", "after"), strings[0]);

const union: ({ label: string } | string)[] = [{ label: "before" }, "tail"];
const unionView: any = union;
console.log("native union", Reflect.set(unionView, "0", { label: "after" }), JSON.stringify(union));
console.log("native union string", Reflect.set(unionView, "1", "end"), JSON.stringify(union));

for (const native of [false, true]) {
  const owner = [1];
  const receiver: any = native ? owner : JSON.parse("[1]");
  const prototype: any = JSON.parse("{}");
  let calls = 0;
  Object.defineProperty(prototype, "1", {
    set: function (_value: number): void { calls++; },
  });
  Object.setPrototypeOf(receiver, prototype);
  console.log("own definition", native, Reflect.set(JSON.parse("{}"), "1", 9, receiver),
    calls, Object.hasOwn(receiver, "1"), receiver[1]);
  if (native) console.log("owner", owner.length, owner[1]);
}

for (const key of ["0", "length"]) {
  const target: any = JSON.parse("[1]");
  Object.freeze(target);
  const receiver: any = JSON.parse("{}");
  console.log("frozen target", key, Reflect.set(target, key, 9, receiver), Object.hasOwn(receiver, key));
}
for (const sealed of [false, true]) {
  const receiver: any = JSON.parse("[1,2,3]");
  delete receiver[2];
  if (sealed) Object.seal(receiver);
  let conversions = 0;
  const value = { valueOf(): number { conversions++; return 0; } };
  console.log("length outcome", sealed, Reflect.set(JSON.parse("{}"), "length", value, receiver),
    conversions, receiver.length, JSON.stringify(receiver));
}
