// The own fields of an Array subclass instance and the named properties of a
// native array, read through a view of the array: their keys, their values
// and their descriptors. A field named `__proto__` is an own property like
// any other, in a class with a few fields and in one with many.

type Bag = Record<string, unknown>;

class Small extends Array<number> {
  before = 1;
  ["__proto__"] = "field";
  after = 2;
}

class Large extends Array<number> {
  before = 1;
  ["__proto__"] = "field";
  after = 2;
  f0 = 0; f1 = 1; f2 = 2; f3 = 3; f4 = 4; f5 = 5; f6 = 6; f7 = 7;
  f8 = 8; f9 = 9; f10 = 10; f11 = 11; f12 = 12; f13 = 13; f14 = 14; f15 = 15;
  f16 = 16; f17 = 17; f18 = 18; f19 = 19; f20 = 20; f21 = 21; f22 = 22; f23 = 23;
  f24 = 24; f25 = 25; f26 = 26; f27 = 27; f28 = 28; f29 = 29; f30 = 30; f31 = 31;
  f32 = 32; f33 = 33; f34 = 34; f35 = 35; f36 = 36; f37 = 37; f38 = 38; f39 = 39;
  f40 = 40; f41 = 41; f42 = 42; f43 = 43; f44 = 44; f45 = 45; f46 = 46; f47 = 47;
  f48 = 48; f49 = 49; f50 = 50; f51 = 51; f52 = 52; f53 = 53; f54 = 54; f55 = 55;
  f56 = 56; f57 = 57; f58 = 58; f59 = 59; f60 = 60; f61 = 61; f62 = 62; f63 = 63;
  f64 = 64; f65 = 65; f66 = 66; f67 = 67; f68 = 68; f69 = 69; f70 = 70; f71 = 71;
}

function report(name: string, view: Bag): void {
  const keys = Object.keys(view).filter((key) => !/^f\d+$/.test(key));
  console.log(name, keys, Object.hasOwn(view, "__proto__"), Array.isArray(view));
  console.log(name, JSON.stringify(Object.getOwnPropertyDescriptor(view, "__proto__")));
  console.log(name, JSON.stringify(Object.getOwnPropertyDescriptor(view, "after")));
  console.log(name, view.before, view.after, Object.keys(view).length);
}

const small = new Small();
small.push(5);
report("small", small as unknown as Bag);
console.log(small instanceof Small, small.length, small.before, small.after);

const large = new Large();
large.push(6, 7);
report("large", large as unknown as Bag);
console.log(large instanceof Large, large.length, large.before, large.after, large.f0, large.f71);
console.log((large as unknown as Bag).f0, (large as unknown as Bag).f71);

// The fields come back on every view, and on a view of a species result.
const tail = large.slice(1);
report("tail", tail as unknown as Bag);
console.log(tail instanceof Large, tail.length);

class Scores extends Array<number> {
  label = "scores";
  total = 0;
}
const scores = new Scores();
scores.push(3, 4);
const view = scores as unknown as Bag;
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(view, "label")));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(view, "total")));
console.log(Object.keys(view), Object.getOwnPropertyNames(view));
console.log(scores);

// A native array's named properties keep the attributes they were defined
// with on each later view.
const list: number[] = [1, 2, 3];
(list as unknown as Bag).plain = "p";
Object.defineProperty(list as unknown as Bag, "fixed", { value: 1, writable: false, enumerable: true, configurable: false });
Object.defineProperty(list as unknown as Bag, "hidden", { value: 2, writable: true, enumerable: false, configurable: true });
for (const name of ["plain", "fixed", "hidden"]) {
  console.log(name, JSON.stringify(Object.getOwnPropertyDescriptor(list as unknown as Bag, name)));
}
console.log(Object.keys(list as unknown as Bag), Object.getOwnPropertyNames(list as unknown as Bag));
delete (list as unknown as Bag).plain;
console.log((list as unknown as Bag).plain, Object.keys(list as unknown as Bag));
console.log(list);

// Numeric properties stay with the array; the named ones beside them are
// copied as they are.
const mixed: number[] = [1, 2];
mixed[-1] = 5;
(mixed as unknown as Bag).name = "mixed";
(mixed as unknown as Bag).second = "two";
console.log(mixed[-1], (mixed as unknown as Bag).name, (mixed as unknown as Bag).second);
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(mixed as unknown as Bag, "name")));
console.log(Object.keys(mixed as unknown as Bag));
delete (mixed as unknown as Bag).name;
console.log(Object.keys(mixed as unknown as Bag));
for (const key in mixed) console.log("mixed key", key);
console.log(mixed);
