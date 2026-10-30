"use strict";

function mutate(receiver: any, name: string, args: any[], borrowed: boolean): any {
  if (borrowed) {
    const prototype: any = Array.prototype;
    return prototype[name].apply(receiver, args);
  }
  return receiver[name](...args);
}

function contents(values: any): string {
  let result = "";
  for (let i = 0; i < values.length; i++) {
    result += Object.hasOwn(values, i) ? String(values[i]) : "_";
    result += ",";
  }
  return result;
}

const names = ["push", "pop", "shift", "unshift", "reverse", "sort", "fill", "copyWithin", "splice"];
const argumentsByMethod: number[][] = [[9, 8], [], [], [9, 8], [], [], [9, 1, 3], [1, 0, 3], [1, 2, 9]];
for (const native of [false, true]) {
  for (const borrowed of [false, true]) {
    for (let i = 0; i < names.length; i++) {
      const owner = [3, 2, 1];
      owner.length = 4;
      const receiver: any = native ? owner : JSON.parse("[3,2,1]");
      if (!native) receiver.length = 4;
      const result = mutate(receiver, names[i]!, argumentsByMethod[i]!, borrowed);
      console.log(native, borrowed, names[i], result === receiver ? "self" : JSON.stringify(result), contents(receiver));
      if (native) console.log("owner", owner.length, contents(owner));
    }
  }
}

for (const name of ["reverse", "sort", "copyWithin"]) {
  function arrayLike(a: number, b: number): number { return a + b; }
  const receiver: any = arrayLike;
  let reads = 0;
  let writes = "";
  Object.defineProperty(receiver, "0", {
    configurable: true,
    get: function(this: unknown): number {
      reads++;
      console.log("getter this", this === receiver);
      return 7;
    },
    set: function(this: unknown, value: number): void {
      console.log("setter this", this === receiver);
      writes += String(value);
    },
  });
  Object.defineProperty(receiver, "1", { value: 3, writable: true, configurable: true });
  const result = mutate(receiver, name, name === "copyWithin" ? [1, 0, 1] : [], true);
  console.log("function", name, result === receiver, reads, writes, receiver[1]);
}

const holeOwner: number[] = [];
holeOwner.length = 2;
holeOwner[1] = 2;
const holeView: any = holeOwner;
const prototype: any = JSON.parse("{}");
Object.defineProperty(prototype, "0", {
  configurable: true,
  get: function(this: unknown): number {
    console.log("hole receiver", this === holeView);
    delete holeView[1];
    return 7;
  },
});
Object.setPrototypeOf(holeView, prototype);
mutate(holeView, "reverse", [], true);
console.log("hole owner", holeOwner.length, Object.hasOwn(holeView, 0), holeOwner[1]);

const sortingOwner = [3, 2, 1];
const sortingView: any = sortingOwner;
let compared = false;
const compare = (left: number, right: number): number => {
  if (!compared) {
    compared = true;
    sortingView.length = 0;
  }
  return left - right;
};
mutate(sortingView, "sort", [compare], true);
console.log("sort owner", sortingOwner.length, contents(sortingOwner), compared);
