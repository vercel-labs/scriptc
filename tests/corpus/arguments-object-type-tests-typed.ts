// The arguments object of a TypeScript function is an object that is not an
// array, like any other: the tests that ask what it is answer so without
// reading it.

function describe(..._woods: string[]): string {
  return [
    Array.isArray(arguments),
    arguments instanceof Array,
    arguments instanceof Object,
    Object.prototype.toString.call(arguments),
  ].join(" ");
}
console.log(describe("oak", "elm", "ash"));

function inMethod(): string {
  class Shelf {
    stock(_count: number, _label?: string): boolean {
      return Array.isArray(arguments) || arguments instanceof Array;
    }
  }
  return String(new Shelf().stock(2));
}
console.log(inMethod());
