// assert.deepStrictEqual over checked-dynamic values applies Node's
// constructor gate: two instances of one class compare by their own
// enumerable fields, two different classes never match, and a class
// instance never matches a plain object — while Object.create(null) still
// differs from a plain object and a custom prototype does not. Arrays
// compare their hole positions as well as their values, so a hole is not
// an own index property and undefined is.
import assert from "node:assert";

function outcome(f: () => void): string {
  try {
    f();
    return "pass";
  } catch (e) {
    return e instanceof Error ? e.message : "not an Error";
  }
}

class Point {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
}

class Pair {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
}

class Labelled {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
  label(): string {
    return "p";
  }
}

const p1: unknown = new Point(1);
const p1b: unknown = new Point(1);
const p2: unknown = new Point(2);
const q1: unknown = new Pair(1);
const r1: unknown = new Labelled(1);
const plain: unknown = { x: 1 };
console.log("A", outcome(() => assert.deepStrictEqual(p1, p1b)));
console.log("B", outcome(() => assert.deepStrictEqual(p1, p2)));
console.log("C", outcome(() => assert.deepStrictEqual(p1, q1)));
console.log("D", outcome(() => assert.deepStrictEqual(p1, r1)));
console.log("E", outcome(() => assert.deepStrictEqual(p1, plain)));
console.log("F", outcome(() => assert.deepStrictEqual(plain, p1)));

const nullProto: any = Object.create(null);
nullProto.a = 1;
const customProto: any = Object.create({ z: 1 });
customProto.a = 1;
const ordinary: unknown = { a: 1 };
console.log("G", outcome(() => assert.deepStrictEqual(nullProto as unknown, ordinary)));
console.log("H", outcome(() => assert.deepStrictEqual(customProto as unknown, ordinary)));

const holes: any = [1, , 3];
const undefs: unknown = [1, undefined, 3];
const holes2: any = [1, , 3];
const holesChanged: any = [1, , 4];
const shortArray: any = [1];
shortArray.length = 3;
const farIndex: any = [1];
farIndex[5] = 2;
const farIndex2: any = [1];
farIndex2[5] = 2;
const named: any = [1];
named.extra = "x";
const named2: any = [1];
named2.extra = "y";
console.log("I", outcome(() => assert.deepStrictEqual(holes as unknown, undefs)));
console.log("J", outcome(() => assert.deepStrictEqual(holes as unknown, holes2 as unknown)));
console.log("K", outcome(() => assert.deepStrictEqual(holes as unknown, holesChanged as unknown)));
console.log("L", outcome(() => assert.deepStrictEqual(shortArray as unknown, holes as unknown)));
console.log("M", outcome(() => assert.deepStrictEqual(farIndex as unknown, farIndex2 as unknown)));
console.log("N", outcome(() => assert.deepStrictEqual(named as unknown, named2 as unknown)));

const looseHoles: unknown = holes;
const looseUndefs: unknown = undefs;
console.log("O", outcome(() => assert.deepEqual(looseHoles, looseUndefs)));
console.log("P", outcome(() => assert.partialDeepStrictEqual(looseHoles, looseUndefs)));

// A derived instance boxed through its base's static type is the same
// runtime class: the constructor Node compares comes from the instance, not
// from the static type the value crossed the unknown boundary through.
class Animal {
  legs: number;
  constructor(legs: number) {
    this.legs = legs;
  }
}
class Bird extends Animal {
  wings: number;
  constructor(legs: number, wings: number) {
    super(legs);
    this.wings = wings;
  }
}
const boxAsBase = (v: Animal): unknown => v;
const bird = new Bird(2, 2);
const birdViaBase = boxAsBase(bird);
const birdDirect: unknown = bird;
console.log("Q", outcome(() => assert.deepStrictEqual(birdViaBase, birdDirect)));
const bird2 = new Bird(2, 2);
const bird2Direct: unknown = bird2;
console.log("R", outcome(() => assert.deepStrictEqual(boxAsBase(bird2), bird2Direct)));
const mammal: unknown = new Animal(2);
console.log("S", outcome(() => assert.deepStrictEqual(birdViaBase, mammal)));
const birdThroughBase = boxAsBase(new Bird(4, 2));
const birdThroughOwnType: unknown = new Bird(4, 2);
console.log("V", outcome(() => assert.deepStrictEqual(birdThroughBase, birdThroughOwnType)));

// Partial equality: an expected hole imposes no property requirement, while
// an expected own undefined needs one on the actual side.
const expectedHole: any = [];
expectedHole.length = 1;
const actualUndefined: unknown = [undefined];
const actualHole: any = [];
actualHole.length = 1;
console.log("T", outcome(() => assert.partialDeepStrictEqual(actualUndefined, expectedHole as unknown)));
console.log("U", outcome(() => assert.partialDeepStrictEqual(actualHole as unknown, actualUndefined)));
