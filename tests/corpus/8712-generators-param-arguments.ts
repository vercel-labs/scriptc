// The call-time prologue the barrier adds must not consume the values the
// iterator protocol delivers: the first next(v) answers the body's first
// yield, exactly as it does for a generator without parameters. Also pins
// the receiver a default initializer reads (bound at the call), and
// `arguments.length` (only the fixed-arity fold is expressible: indexing
// `arguments` inside a generator is an explicit SC1090 refusal).
function* echo(a: string = "d"): Generator<string, void, string> {
  const first = yield "one:" + a;
  const second = yield "two:" + first;
  yield "three:" + second;
}
const g = echo();
console.log(g.next("A").value as string); // "A" belongs to the prologue
console.log(g.next("B").value as string);
console.log(g.next("C").value as string);

// A default initializer reads `this`, which the call binds before it runs.
class Box {
  base = "b";
  *label(a: string = this.base): Generator<string, void, unknown> {
    yield "label:" + a;
  }
}
const box = new Box();
const implicit = box.label();
console.log(implicit.next().value as string);
console.log(implicit.next().done === true);
const given = box.label("given");
console.log(given.next().value as string);
console.log(given.next().done === true);

// arguments.length inside a generator is the call's count.
function* counted(a: number, b: number): Generator<number, void, unknown> {
  yield arguments.length;
}
const c = counted(1, 2);
console.log(c.next().value as number);
console.log(c.next().done === true);

// return() before the first next() completes a generator whose parameters
// bound at the call, without running the body.
let ran = 0;
function* guarded(a: string = "x"): Generator<string, void, unknown> {
  ran++;
  yield a;
}
const r = guarded();
const ret = r.return();
console.log(ret.done === true, ret.value === undefined);
console.log(r.next().done === true);
console.log("ran", ran);
console.log("done");
