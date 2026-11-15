// Writes to members of built-in objects in typed code that nothing in the
// program reads natively (the JavaScript twin is
// builtin-member-writes-unread.cjs): the readers the runtime serves from the
// object see them, and a use of another class's member of the same name is
// no use of the written one.
let calls = 0;

// A replaced method read back through the prototype object.
const originalPush = Array.prototype.push;
Array.prototype.push = function (this: unknown[], ...items: unknown[]): number {
  calls++;
  return originalPush.apply(this, items);
};
console.log("push", typeof Array.prototype.push, Array.prototype.push === originalPush, calls);

// `includes` of a string and of the program's own class are not the array's.
Array.prototype.includes = function (this: unknown[]): boolean {
  calls++;
  return true;
};
const text: string = "abc";
class Bag {
  includes(value: number): boolean {
    return value === 1;
  }
}
console.log("includes", text.includes("z"), new Bag().includes(2), calls);

// A replaced iterator: for...of and Array.from over an untyped value run it.
(Array.prototype as any)[Symbol.iterator] = function () {
  return {
    next() {
      return { done: true };
    },
  };
};
function count(values: any): number {
  let n = 0;
  for (const value of values) n++;
  return n;
}
function copy(values: any): unknown[] {
  return Array.from(values);
}
const numbers: number[] = [1, 2];
console.log("iterate", count(numbers), copy(numbers).length);
