// A class that extends Array overrides Array.prototype methods. Node finds
// the method on the instance's prototype chain, so a call through a value
// the checker types as a plain array (a base-typed variable, a union arm, a
// callback parameter typed Array<T>) runs the override too, while a plain
// array keeps the builtin. The class's own methods call super.m(), which is
// Array.prototype's method over the instance as an array.
class Tagged extends Array<number> {
  tag: string | number;
  calls: string[] = [];

  constructor(tag: string | number = "T") {
    super();
    this.tag = tag;
  }

  push(...xs: number[]): number {
    this.calls.push("push:" + xs.join(","));
    return super.push(...xs);
  }

  pop(): number | undefined {
    this.calls.push("pop");
    return super.pop();
  }

  splice(start: number, deleteCount: number): number[] {
    this.calls.push("splice:" + start + "," + deleteCount);
    return super.splice(start, deleteCount);
  }

  filter(cb: (value: number, index: number, array: number[]) => boolean): number[] {
    this.calls.push("filter");
    return super.filter(cb);
  }

  forEach(cb: (value: number, index: number, array: number[]) => void, thisArg?: unknown): void {
    this.calls.push("forEach");
    super.forEach(cb, thisArg);
  }
}

const tagged = new Tagged("T");
// Through the subclass type: the class's own methods.
tagged.push(3, 1, 2);
console.log("subclass push", tagged.length, tagged.tag, tagged.calls.join("|"));
console.log("subclass pop", tagged.pop(), tagged.length);

// Through the base type.
const base: number[] = tagged;
base.push(7);
console.log("base push", base.length, tagged.calls.join("|"), base === (tagged as number[]));
console.log("base splice", base.splice(0, 1).join(","), base.join(","));
console.log("base filter", base.filter((v) => v > 1).join(","), tagged.calls.join("|"));
const seen: string[] = [];
base.forEach((v, i) => seen.push(i + ":" + v));
console.log("base forEach", seen.join(","), tagged.calls.join("|"));

// Through a union arm.
const union: Tagged | number[] = tagged;
union.push(5);
console.log("union push", union.length, tagged.calls.join("|"));
const plainUnion: Tagged | number[] = [4];
plainUnion.push(6);
console.log("union plain", plainUnion.length, plainUnion.join(","));

// Through a callback parameter typed Array<T>.
function append(xs: number[], value: number): void {
  xs.push(value);
}
append(tagged, 8);
append([1, 2], 9);
console.log("parameter push", tagged.length, tagged.calls.join("|"));

// A plain array keeps the builtin for every method.
const plain = [10, 20];
plain.push(30);
console.log("plain", plain.length, plain.pop(), plain.join(","), plain.map((v) => v + 1).join(","));

// JSON.stringify of an instance writes its elements, not its own fields.
console.log("json", JSON.stringify(tagged), Array.isArray(tagged), tagged instanceof Tagged);

// Symbol.species: map, filter, slice, splice and concat construct the class.
class Doubled extends Array<number> {}
const doubled = new Doubled();
doubled.push(1, 2, 3, 4);
const mapped = doubled.map((v) => v * 2);
const filtered = doubled.filter((v) => v % 2 === 0);
const sliced = doubled.slice(1, 3);
const spliced = doubled.splice(0, 1);
const concatenated = doubled.concat([9]);
console.log(
  "species",
  mapped instanceof Doubled,
  filtered instanceof Doubled,
  sliced instanceof Doubled,
  spliced instanceof Doubled,
  concatenated instanceof Doubled,
);
console.log(
  "species values",
  mapped.join(","),
  filtered.join(","),
  sliced.join(","),
  spliced.join(","),
  concatenated.join(","),
  doubled.join(","),
);

// An override that returns the instance's species result through super: the
// returned array is a Tagged instance.
const slicedTagged = tagged.splice(0, 0);
console.log("super species", slicedTagged instanceof Tagged, slicedTagged.length);
