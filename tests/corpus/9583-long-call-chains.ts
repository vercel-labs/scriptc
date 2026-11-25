// Long call chains whose receivers declare something when they are lowered:
// arrow functions, the temporaries of slice and Map.set, the dispatch of a
// union receiver. Each call's receiver is lowered once, however many forms
// look at it, so these compile in time proportional to their length (the
// array chain below used to take three lowerings per link, 3^14 in all).
// The values pin that every link still runs once and in source order.

const trace: string[] = [];
function note<T>(label: string, value: T): T {
  trace.push(label);
  return value;
}

// Array methods taking arrow functions, 14 links.
const numbers = [5, 3, 8, 1, 9, 2];
const arrayChain = numbers
  .map((n) => n + 1)
  .filter((n) => n % 2 === 0 || n > 4)
  .map((n) => n * 3)
  .filter((n) => n !== 18)
  .map((n, i) => n + i)
  .filter((n) => n > 0)
  .map((n) => note(`a${n}`, n - 1))
  .filter((n) => n % 5 !== 0)
  .map((n) => n * 2)
  .filter((n) => n < 100)
  .map((n) => n + 7)
  .filter((n) => n !== 7)
  .map((n) => `${n}`)
  .join(",");
console.log(arrayChain);
console.log(trace.join(" "));

// Array methods that only need temporaries.
const reordered = numbers
  .slice(1)
  .concat([4, 6])
  .reverse()
  .slice(0, 6)
  .concat(numbers.slice(0, 2))
  .reverse()
  .slice(1, 7)
  .concat([0])
  .reverse()
  .slice(0)
  .join("");
console.log(reordered);
console.log(numbers.join(""));

// Calls through a record, each taking a closure over a different variable.
interface Later {
  then(f: (n: number) => number): Later;
  done(): number;
}
function later(total: number): Later {
  return { then: (f) => later(f(total)), done: () => total };
}
const one = 1;
const two = 2;
let three = 3;
const laterChain = later(0)
  .then((n) => n + one)
  .then((n) => n * two + three)
  .then((n) => {
    three += 1;
    return n + three;
  })
  .then((n) => n - one)
  .then((n) => n * n)
  .then((n) => n + three)
  .then((n) => n % 50)
  .then((n) => n + two)
  .then((n) => n * three)
  .then((n) => n - 1)
  .then((n) => n + one + two + three)
  .then((n) => n * 2)
  .done();
console.log(laterChain, three);

// A generic class whose methods take closures and change the type.
class Box<T> {
  readonly value: T;
  constructor(value: T) {
    this.value = value;
  }
  map<U>(f: (value: T) => U): Box<U> {
    return new Box(f(this.value));
  }
}
const boxed = new Box(2)
  .map((n) => n + 1)
  .map((n) => `${n}!`)
  .map((s) => s.length)
  .map((n) => [n, n * 2])
  .map((pair) => pair[0]! + pair[1]!)
  .map((n) => n > 5)
  .map((flag) => (flag ? "big" : "small"))
  .map((s) => s.toUpperCase())
  .map((s) => s + s)
  .map((s) => s.length).value;
console.log(boxed);

// Map and Set methods return their receiver.
const table = new Map<string, number>()
  .set("a", 1)
  .set("b", 2)
  .set("c", 3)
  .set("a", 4)
  .set("d", 5)
  .set("e", 6)
  .set("b", 7)
  .set("f", 8)
  .set("g", 9)
  .set("h", 10);
console.log(table.size, [...table.keys()].join(""), table.get("a"), table.get("b"));
const members = new Set<number>().add(3).add(1).add(3).add(2).add(1).add(5).add(8).add(2).add(13).add(21);
console.log(members.size, [...members].join(","));

// A receiver whose type is a union of classes.
class Even {
  readonly n: number;
  constructor(n: number) {
    this.n = n;
  }
  next(by: number): Even | Odd {
    return (this.n + by) % 2 === 0 ? new Even(this.n + by) : new Odd(this.n + by);
  }
  kind(): string {
    return "even";
  }
}
class Odd {
  readonly n: number;
  constructor(n: number) {
    this.n = n;
  }
  next(by: number): Even | Odd {
    return (this.n + by) % 2 === 0 ? new Even(this.n + by) : new Odd(this.n + by);
  }
  kind(): string {
    return "odd";
  }
}
const start: Even | Odd = new Even(0);
const walked = start
  .next(1)
  .next(2)
  .next(3)
  .next(5)
  .next(8)
  .next(13)
  .next(21)
  .next(34)
  .next(55)
  .next(89)
  .next(144)
  .next(233);
console.log(walked.n, walked.kind());

// Every link's argument is evaluated once, left to right, receiver first.
const order: string[] = [];
function step(label: string): number {
  order.push(label);
  return label.length;
}
const evaluated = later(step("root"))
  .then((n) => n + step("first"))
  .then((n) => n + step("second"))
  .then((n) => n + step("third"))
  .done();
console.log(evaluated, order.join(">"));
