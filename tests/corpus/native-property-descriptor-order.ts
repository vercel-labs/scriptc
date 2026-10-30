"use strict";

for (const batch of [false, true]) {
  let order = "";
  const target: any = JSON.parse("{}");
  const prototype: any = JSON.parse("{}");
  let descriptor: any;
  for (const field of ["enumerable", "configurable", "value", "writable"]) {
    Object.defineProperty(prototype, field, {
      get: function (this: unknown): number | boolean {
        order += field + ":" + (this === descriptor) + ";";
        return field === "value" ? 42 : true;
      },
    });
  }
  descriptor = Object.create(prototype);
  if (batch) Object.defineProperties(target, { extra: descriptor });
  else Object.defineProperty(target, "extra", descriptor);
  console.log("inherited", batch, order, JSON.stringify(target));
}

for (const batch of [false, true]) {
  let order = "";
  const target: any = JSON.parse("{}");
  const descriptor: any = JSON.parse("{}");
  Object.defineProperty(descriptor, "get", {
    get: function (): number { order += "get;"; return 1; },
  });
  Object.defineProperty(descriptor, "set", {
    get: function (): undefined { order += "set;"; return undefined; },
  });
  try {
    if (batch) Object.defineProperties(target, { first: { value: 1 }, extra: descriptor });
    else Object.defineProperty(target, "extra", descriptor);
  } catch (error) {
    console.log("invalid getter", batch, error instanceof TypeError, order, Object.getOwnPropertyNames(target));
  }
}

const array: any = JSON.parse("[]");
let order = "";
const key: any = { toString(): string { order += "key;"; return "extra"; } };
const descriptor: any = JSON.parse("{}");
Object.defineProperty(descriptor, "value", {
  get: function (): number { order += "value;"; return 42; },
});
Object.defineProperty(array, key, descriptor);
console.log("key once", order, array.extra);

const symbol = Symbol("extra");
const target: any = JSON.parse("{}");
const reentrant: any = JSON.parse("{}");
Object.defineProperty(reentrant, "value", {
  get: function (): number {
    Object.defineProperty(target, symbol, { value: 7, configurable: true });
    return 42;
  },
});
Object.defineProperty(target, symbol, reentrant);
console.log("symbol reentry", target[symbol], Object.getOwnPropertySymbols(target).length);
const batchTarget: any = JSON.parse("{}");
const descriptors: any = { first: { value: 1 }, [symbol]: { value: 42 } };
Object.defineProperties(batchTarget, descriptors);
console.log("batch symbol", batchTarget.first, batchTarget[symbol], Object.getOwnPropertySymbols(batchTarget).length);

const partial: any = JSON.parse("{}");
Object.defineProperty(partial, "fixed", { value: 1 });
try {
  Object.defineProperties(partial, { first: { value: 7 }, fixed: { value: 2 }, later: { value: 9 } });
} catch (error) {
  console.log("application prefix", error instanceof TypeError, partial.first, partial.fixed, Object.hasOwn(partial, "later"));
}

class Item { value = 1; }
for (const throws of [false, true]) {
  const item = new Item();
  const view: any = item;
  const marker: any = JSON.parse("{}");
  const nativeDescriptor: any = JSON.parse("{}");
  Object.defineProperty(nativeDescriptor, "value", {
    get: function (): number {
      item.value = 9;
      if (throws) throw marker;
      return 42;
    },
  });
  try {
    Object.defineProperty(view, "extra", nativeDescriptor);
    console.log("native alias", item.value, view.extra);
  } catch (error) {
    console.log("native throw", error === marker, item.value, Object.hasOwn(view, "extra"));
  }
}
