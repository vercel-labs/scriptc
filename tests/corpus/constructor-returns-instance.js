// JavaScript constructors whose returned value is typed only at run time:
// an instance of the class replaces `this`, a primitive keeps it.
class Connection {
  constructor(url) {
    if (Connection.open && Connection.open.url === url) return Connection.open;
    this.url = url;
    this.uses = 0;
    Connection.open = this;
  }
  use() {
    this.uses++;
    return this;
  }
}
const c1 = new Connection("db://a").use();
const c2 = new Connection("db://a").use();
const c3 = new Connection("db://b").use();
console.log(c1 === c2, c2.uses, c3 === c1, c3.uses, c3.url);

class Counter {
  constructor(start, answer) {
    this.count = start;
    return answer;
  }
}
console.log(new Counter(1, 5).count, new Counter(2, "x").count, new Counter(3, null).count);
console.log(new Counter(4, undefined).count, new Counter(5, true).count);
const kept = new Counter(6, 0);
console.log(new Counter(7, kept) === kept, kept.count);

const memoCache = new Map();
let memoCreated = 0;
class Memo {
  constructor(key) {
    const hit = memoCache.get(key);
    if (hit !== undefined) return hit;
    this.key = key;
    this.created = ++memoCreated;
    memoCache.set(key, this);
  }
}
const m1 = new Memo("k");
const m2 = new Memo("k");
const m3 = new Memo("j");
console.log(m1 === m2, m3 === m1, m2.created, m3.created, memoCreated);
