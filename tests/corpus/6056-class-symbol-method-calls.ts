// Well-known symbol methods called through element access, and
// Iterator.from over a class whose [Symbol.iterator] is a generator method:
// both give the class's own generator, so iterator helpers apply to it.
class Range {
  lo: number;
  hi: number;
  constructor(lo: number, hi: number) {
    this.lo = lo;
    this.hi = hi;
  }
  *[Symbol.iterator](): Generator<number> {
    for (let i = this.lo; i < this.hi; i++) yield i;
  }
}
class Labeled extends Range {
  label = "l";
}
class Words {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
  *[Symbol.iterator](): Generator<string> {
    for (const w of this.text.split(" ")) yield w;
  }
}
class Money {
  cents: number;
  constructor(cents: number) {
    this.cents = cents;
  }
  [Symbol.toPrimitive](hint: string): string | number {
    return hint === "number" ? this.cents / 100 : `$${(this.cents / 100).toFixed(2)}`;
  }
}
class Handle {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  [Symbol.dispose](): void {
    console.log("dispose", this.name);
  }
}

const r = new Range(1, 6);
const direct = r[Symbol.iterator]();
console.log(direct.next(), direct.next());
console.log(r[Symbol.iterator]().map((x) => x + 1).toArray());
const ranges: Range[] = [new Range(0, 3), new Labeled(5, 7)];
for (const x of ranges) console.log(x[Symbol.iterator]().toArray());
console.log(r[Symbol.iterator]().filter((x) => x > 3).toArray());

const it = Iterator.from(r);
console.log(it.next().value, it.next().value);
console.log([...it]);
console.log(Iterator.from(r).map((x) => x * 10).toArray());
console.log(Iterator.from(r).filter((x) => x % 2 === 1).toArray());
console.log(Iterator.from(r).take(2).toArray(), Iterator.from(r).drop(3).toArray());
console.log(Iterator.from(r).reduce((a, b) => a + b, 0));
console.log(Iterator.from(r).some((x) => x > 4), Iterator.from(r).every((x) => x > 0));
console.log(Iterator.from(r).find((x) => x > 2));
console.log(Iterator.from(new Words("a bb ccc")).map((w) => w.length).toArray());
Iterator.from(r).forEach((x) => console.log("each", x));
for (const x of Iterator.from(r).flatMap((x) => [x, -x]).take(4)) console.log(x);
const g = Iterator.from(r);
for (const x of g) {
  if (x === 2) break;
}
console.log(g.next());

console.log(Iterator.from(r), r[Symbol.iterator](), Iterator.from(r).map((x) => x));
console.log(Iterator.from(r).flatMap((x) => new Set([x, x + 10])).toArray());
console.log(r[Symbol.iterator]().flatMap((x) => new Map([[x, String(x)]])).toArray());

const m = new Money(1234);
console.log(m[Symbol.toPrimitive]("number"), m[Symbol.toPrimitive]("default"));
new Handle("h")[Symbol.dispose]();
