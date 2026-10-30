"use strict";

function inspect(value: unknown, key: string): void {
  const array = value as Record<string, unknown>;
  console.log(typeof array[key], key in array, "push" in array);
  console.log(typeof Reflect.get(array, key), typeof Object.getPrototypeOf(array)[key]);
}

function append(value: any, key: string, ...items: number[]): void {
  console.log(value[key](...items), value.join(","));
}

const checked: unknown = JSON.parse("[1,2]");
const native: number[] = [1,2];
inspect(checked, "push");
inspect(native, "push");

append(checked, "push", 3, 4);
append(native, "push", 3, 4);
console.log(native.join(","));

const prototype: any = Array.prototype;
const saved = prototype["push"];
delete prototype["push"];
inspect(checked, "push");
inspect(native, "push");
Object.defineProperty(prototype, "push", {
  value: saved,
  writable: true,
  configurable: true,
});
inspect(native, "push");

const receiver: unknown = JSON.parse('{"marker":true}');
Object.defineProperty(prototype, "receiver", {
  configurable: true,
  get: function (this: unknown): unknown { return this; },
});
const child = Object.create(checked as object);
console.log(
  Reflect.get(checked as object, "receiver", receiver) === receiver,
  Reflect.get(native, "receiver", receiver) === receiver,
  Reflect.get(child, "receiver", receiver) === receiver,
);
delete prototype["receiver"];
Object.setPrototypeOf(checked as object, null);
console.log(typeof Reflect.get(checked as object, "push"));
