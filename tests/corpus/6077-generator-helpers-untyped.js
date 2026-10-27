// Iterator helpers on compiled generators that reach untyped parameters:
// the runtime's helpers step the generator through its own next() and
// close it through return().
const log = [];
const flush = () => log.splice(0).join(" ");
function* count(n) {
  try {
    for (let i = 1; i <= n; i++) {
      log.push("y" + i);
      yield i;
    }
    return "done";
  } finally {
    log.push("closed");
  }
}
function twice(it) { return it.map((x) => x * 2).toArray(); }
console.log(twice(count(3)), flush());
function firstOver(it, k) { return it.find((x) => x > k); }
console.log(firstOver(count(9), 3), flush());
function stepper(it) {
  const h = it.filter((x) => x % 2 === 1);
  return [h.next(), h.next(), h.return(), h.next()];
}
console.log(stepper(count(9)), flush());
function sum(it) { return it.reduce((a, b) => a + b, 0); }
console.log(sum(count(4)), flush());
function product(it) { return it.reduce((a, b) => a * b); }
console.log(product(count(4)), flush());
function lazy(it) { return it.drop(1).take(2); }
console.log([...lazy(count(9))], flush());
function each(it) { const out = []; it.forEach((x, i) => out.push(x + ":" + i)); return out; }
console.log(each(count(3)), flush());
function some(it) { return it.some((x) => x === 2); }
console.log(some(count(5)), flush());
function every(it) { return it.every((x) => x < 3); }
console.log(every(count(5)), flush());
function flat(it) { return it.flatMap((x) => [x, -x]).toArray(); }
console.log(flat(count(2)), flush());
function chain(it) { return it.map((x) => x + 1).filter((x) => x % 2 === 0).map(String).toArray(); }
console.log(chain(count(6)), flush());
function loop(it) {
  const out = [];
  for (const x of it.map((x) => x * 10)) {
    out.push(x);
    if (x >= 20) break;
  }
  return out;
}
console.log(loop(count(5)), flush());
function from(it) { return Array.from(it.take(2)); }
console.log(from(count(5)), flush());
function zeroTake(it) { return it.take(0).toArray(); }
console.log(zeroTake(count(5)), flush());
function after(it) { const a = it.take(1).toArray(); return [a, it.next()]; }
console.log(after(count(3)), flush());
function failing(it) {
  try {
    it.map((x) => { if (x === 2) throw new Error("boom " + x); return x; }).toArray();
  } catch (e) {
    return e.message;
  }
}
console.log(failing(count(5)), flush());
function errorOf(run) { try { run(); } catch (e) { return e.name + ": " + e.message; } }
function check(it) {
  return [
    errorOf(() => it.map(42)),
    errorOf(() => it.take(-1)),
    errorOf(() => it.reduce((a, b) => a + b)),
  ];
}
console.log(check(count(0)), flush());
function kinds(it) { return [typeof it.map, typeof it.toArray, typeof it.next]; }
console.log(kinds(count(1)));
function readNext(it) { const next = it.next; return [next.call(it), next.call(it)]; }
console.log(readNext(count(5)), flush());
function first(it) { for (const x of it) return x; }
console.log(first(count(3)), flush());
function closeEarly(it) { it.next(); return it.return(); }
console.log(closeEarly(count(3)), flush());
