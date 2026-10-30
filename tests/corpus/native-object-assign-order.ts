"use strict";

for (const native of [false, true]) {
  const owner = [1, 2];
  const target: any = native ? owner : JSON.parse("[1,2]");
  const source: any = JSON.parse('{"0":9,"2":8}');
  const result = Object.assign(target, source);
  console.log("array target", native, result === target, JSON.stringify(target));
  if (native) console.log("native target", owner.length, owner[0], owner[2]);
}

for (let mode = 0; mode < 3; mode++) {
  const owner = [1, 2];
  const source: any = owner;
  const target: any = JSON.parse("{}");
  Object.defineProperty(target, "0", {
    set: function (this: unknown, _value: number): void {
      console.log("setter receiver", this === target);
      if (mode === 0) owner[1] = 9;
      else if (mode === 1) delete source[1];
      else owner.push(9);
    },
  });
  Object.assign(target, source);
  console.log("source change", mode, JSON.stringify(target), JSON.stringify(owner));
}

const target: any = JSON.parse("{}");
const source: any = JSON.parse("[1]");
const marker: any = JSON.parse('{"message":"copy stopped"}');
Object.defineProperty(source, "later", {
  enumerable: true,
  get: function (this: unknown): number {
    console.log("getter receiver", this === source);
    throw marker;
  },
});
try {
  Object.assign(target, source);
} catch (error) {
  console.log("partial copy", error === marker, target[0]);
}

const key = Symbol("value");
class Item {
  value = 1;
  [key] = 2;
}
const item = new Item();
const view: any = item;
const values: any = { value: 9, [key]: 8 };
Object.assign(view, values);
console.log("native fields", item.value, item[key]);
