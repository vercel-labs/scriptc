// `class X extends Iterator` in JavaScript: construction, instanceof, the
// inherited statics, and the helpers over instances whose next and return
// are methods or accessors, with return() forwarded when a stage or a
// consumer closes early.
class SubIterator extends Iterator {}
const plain = new SubIterator();
console.log(plain instanceof SubIterator, plain instanceof Iterator, SubIterator.from === Iterator.from);

class Counter extends Iterator {
  constructor(limit) {
    super();
    this.n = 0;
    this.limit = limit;
  }
  next() {
    return this.n < this.limit ? { value: this.n++, done: false } : { value: undefined, done: true };
  }
  return() {
    console.log("return at", this.n);
    return { value: undefined, done: true };
  }
}
const c = new Counter(5);
console.log(c instanceof Iterator, c.map((x) => x * x).take(3).toArray().join(","));
console.log(new Counter(3).toArray().join(","), new Counter(4).reduce((a, b) => a + b, 0));
let it = new Counter(10).filter((x) => x % 3 === 0);
console.log(JSON.stringify(it.next()), JSON.stringify(it.next()), JSON.stringify(it.return()));
for (const v of new Counter(2).drop(1)) console.log("for-of", v);
console.log(new Counter(3).some((x) => x === 1), new Counter(3).find((x) => x > 5));
console.log(new Counter(3).every((x) => x < 2), new Counter(2).flatMap((x) => [x, x]).toArray().join(","));

// Test262's shape: `next` is a getter that answers the next function.
function* source() {
  yield "a";
  yield "b";
  yield "c";
}
class GetterIterator extends Iterator {
  get next() {
    const g = source();
    return () => g.next();
  }
  return() {
    console.log("closed");
    return {};
  }
}
console.log(new GetterIterator().map((s) => s.toUpperCase()).toArray().join(""));
const taken = new GetterIterator().take(1);
console.log(JSON.stringify(taken.next()), JSON.stringify(taken.next()));
let sum = "";
new GetterIterator().forEach((s, i) => {
  sum += s + i;
});
console.log(sum);
try {
  new GetterIterator().map(5);
} catch (e) {
  console.log(e.constructor.name, e.message);
}

// A class expression (and a class declared inside a function) extending
// Iterator takes the same live %Iterator.prototype% base prototype.
function localDecl() {
  class Inside extends Iterator {
    next() {
      return { done: true, value: undefined };
    }
  }
  const inside = new Inside();
  return inside.toArray().length + " " + (inside instanceof Iterator);
}
console.log(localDecl());
function localExpr() {
  const Inside = class extends Iterator {
    next() {
      return { done: true, value: undefined };
    }
  };
  const inside = new Inside();
  return inside.toArray().length + " " + (inside instanceof Iterator);
}
console.log(localExpr());
