// The resolve function of a typed promise as a value: stored, handed to another function, kept in
// a field or an array, returned in a record, and called later with a promise or with a value whose
// type says it may be one. It is the same function the executor calls, so the promise is adopted
// the same way and a later call changes nothing.
interface Box {
  a: number;
}
let tick = 0;
function spin(i: number): void {
  if (i < 12) {
    Promise.resolve().then(() => {
      tick++;
      spin(i + 1);
    });
  }
}
function note<T>(label: string, p: Promise<T>, text: (value: T) => string): void {
  p.then(
    (v) => {
      console.log(label, "fulfilled", text(v), "tick", tick);
    },
    (e) => {
      console.log(label, "rejected", e instanceof Error ? e.message : String(e), "tick", tick);
    },
  );
}
const num = (v: number): string => String(v);
const boxText = (v: Box): string => `{a:${v.a}}`;
function maybe(now: boolean): Box | Promise<Box> {
  return now ? { a: 1 } : Promise.resolve<Box>({ a: 2 });
}
spin(0);

// A variable typed as the library types the resolve function.
let stored: ((value: number | PromiseLike<number>) => void) | undefined;
note("stored, library type", new Promise<number>((resolve) => { stored = resolve; }), num);
function settleStored(): void {
  if (stored === undefined) return;
  stored(Promise.resolve(1));
  stored(2);
}
settleStored();

// A variable typed with the union itself, called with each arm.
let exact: (value: number | Promise<number>) => void = () => {};
note("stored, union type, promise", new Promise<number>((resolve) => { exact = resolve; }), num);
exact(Promise.resolve(3));
note("stored, union type, value", new Promise<number>((resolve) => { exact = resolve; }), num);
exact(4);
note("stored, union type, rejection", new Promise<number>((resolve) => { exact = resolve; }), num);
exact(Promise.reject<number>(new Error("stored")));

// Handed to a function that calls it.
function settle(resolve: (value: Box | PromiseLike<Box>) => void, now: boolean): void {
  resolve(maybe(now));
}
note("handed, value", new Promise<Box>((resolve) => settle(resolve, true)), boxText);
note("handed, promise", new Promise<Box>((resolve) => settle(resolve, false)), boxText);

// Kept in an array and in a field.
const waiting: Array<(value: Box | Promise<Box>) => void> = [];
note("array, promise", new Promise<Box>((resolve) => { waiting.push(resolve); }), boxText);
note("array, value", new Promise<Box>((resolve) => { waiting.push(resolve); }), boxText);
waiting[0]!(maybe(false));
waiting[1]!(maybe(true));
class Gate {
  open: (value: string | Promise<string>) => void = () => {};
  readonly done: Promise<string>;
  constructor() {
    this.done = new Promise<string>((resolve) => {
      this.open = resolve;
    });
  }
}
const gate = new Gate();
note("field", gate.done, (v) => v);
gate.open(Promise.resolve("opened"));
gate.open("ignored");

// A deferred written by hand: both functions leave the executor.
interface Deferred {
  promise: Promise<number>;
  resolve: (value: number | Promise<number>) => void;
  reject: (reason: Error) => void;
}
function defer(): Deferred {
  let resolve: (value: number | Promise<number>) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<number>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const first = defer();
note("deferred, promise then reject", first.promise, num);
first.resolve(Promise.resolve(5));
first.reject(new Error("ignored"));
const second = defer();
note("deferred, reject then promise", second.promise, num);
second.reject(new Error("rejected first"));
second.resolve(Promise.resolve(6));
const third = defer();
note("deferred, pending promise then value", third.promise, num);
third.resolve(new Promise<number>((resolve) => { setTimeout(() => resolve(7), 1); }));
third.resolve(8);

// As a reaction of another promise, and beside a direct call in the same executor.
note("then callback", new Promise<number>((resolve) => {
  if (tick > 0) resolve(Promise.resolve(0));
  else Promise.resolve(9).then(resolve);
}), num);
// A slot that takes the plain value only: the function it holds fulfils, as before.
let plain: (value: number) => void = () => {};
note("plain slot", new Promise<number>((resolve) => { plain = resolve; }), num);
plain(10);
