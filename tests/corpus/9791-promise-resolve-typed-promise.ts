// The resolve function of a typed promise called with a promise, or with a value whose type says
// it may be one: the new promise adopts it. It settles as that promise does, two turns later than
// with a plain value, and from the call on a second resolve, a reject and a throw of the executor
// change nothing. Each line carries the microtask turn it was printed in.
interface Box {
  a: number;
}
class Item {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
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
function maybe(now: boolean): number | Promise<number> {
  return now ? 2 : Promise.resolve(3);
}
function failing(now: boolean): number | Promise<number> {
  return now ? 2 : Promise.reject<number>(new Error("union"));
}
spin(0);

// The argument is a promise.
note("fulfilled promise", new Promise<number>((resolve) => { resolve(Promise.resolve(7)); }), num);
note("rejected promise", new Promise<number>((resolve) => { resolve(Promise.reject<number>(new Error("r"))); }), num);
const later = new Promise<number>((resolve) => { setTimeout(() => resolve(5), 1); });
note("pending promise", new Promise<number>((resolve) => { resolve(later); }), num);
note("plain value", new Promise<number>((resolve) => { resolve(1); }), num);

// The argument's type says it may be one.
note("union holding the value", new Promise<number>((resolve) => { resolve(maybe(true)); }), num);
note("union holding the promise", new Promise<number>((resolve) => { resolve(maybe(false)); }), num);
note("union holding a rejection", new Promise<number>((resolve) => { resolve(failing(false)); }), num);

// The first resolution is the only one.
note("resolved twice", new Promise<number>((resolve) => { resolve(later); resolve(9); }), num);
note("resolved then rejected", new Promise<number>((resolve, reject) => { resolve(later); reject(new Error("late")); }), num);
note("resolved then thrown", new Promise<number>((resolve) => { resolve(later); throw new Error("thrown"); }), num);
note("promise then value", new Promise<number>((resolve) => { resolve(Promise.resolve(6)); resolve(8); }), num);
note("value then promise", new Promise<number>((resolve) => { resolve(4); resolve(Promise.resolve(1)); }), num);
note("rejected then promise", new Promise<number>((resolve, reject) => { reject(new Error("first")); resolve(Promise.resolve(1)); }), num);
note("rejection then value", new Promise<number>((resolve) => { resolve(Promise.reject<number>(new Error("kept"))); resolve(8); }), num);
note("thrown before", new Promise<number>((resolve) => { if (tick === 0) throw new Error("early"); resolve(later); }), num);

// A promise resolved with itself, and a promise resolved with a promise resolved with a promise.
const self: Promise<number> = new Promise<number>((resolve) => { setTimeout(() => { resolve(self); }, 5); });
note("itself", self, num);
note("nested", new Promise<number>((resolve) => {
  resolve(new Promise<number>((inner) => { inner(Promise.resolve(11)); }));
}), num);

// What the promise carries: the same object, whatever its type.
const box: Box = { a: 1 };
note("record", new Promise<Box>((resolve) => { resolve(Promise.resolve(box)); }), (v) => `{a:${v.a}} same ${v === box}`);
const item = new Item("x");
function findItem(now: boolean): Item | Promise<Item> {
  return now ? item : Promise.resolve(item);
}
note("class instance", new Promise<Item>((resolve) => { resolve(findItem(false)); }), (v) => `${v.name} ${v instanceof Item} same ${v === item}`);
note("string", new Promise<string>((resolve) => { resolve(Promise.resolve("text")); }), (v) => v);
note("boolean", new Promise<boolean>((resolve) => { resolve(Promise.resolve(true)); }), (v) => String(v));
const list = [1, 2];
note("array", new Promise<number[]>((resolve) => { resolve(Promise.resolve(list)); }), (v) => `${v.join(",")} same ${v === list}`);
note("void", new Promise<void>((resolve) => { resolve(Promise.resolve()); }), () => "undefined");
function nothing(now: boolean): void | Promise<void> {
  return now ? undefined : Promise.resolve();
}
note("void union", new Promise<void>((resolve) => { resolve(nothing(false)); }), () => "undefined");
note("void rejection", new Promise<void>((resolve) => { resolve(Promise.reject(new Error("void"))); }), () => "undefined");
note("union payload", new Promise<number | string>((resolve) => { resolve(Promise.resolve<number | string>("s")); }), (v) => typeof v + " " + String(v));
note("optional payload", new Promise<Box | undefined>((resolve) => { resolve(Promise.resolve<Box | undefined>(undefined)); }), (v) => (v === undefined ? "undefined" : "box"));

// The order of the reactions, against two chains of plain reactions.
const order: string[] = [];
new Promise<number>((resolve) => { resolve(Promise.resolve(1)); }).then((v) => { order.push(`adopted ${v}`); });
Promise.resolve()
  .then(() => { order.push("a1"); })
  .then(() => { order.push("a2"); })
  .then(() => { order.push("a3"); })
  .then(() => { order.push("a4"); });
new Promise<number>((resolve) => { resolve(2); }).then((v) => { order.push(`plain ${v}`); });
new Promise<number>((resolve) => { resolve(maybe(true)); }).then((v) => { order.push(`union value ${v}`); });
new Promise<number>((resolve) => { resolve(maybe(false)); }).then((v) => { order.push(`union promise ${v}`); });
Promise.resolve()
  .then(() => { order.push("b1"); })
  .then(() => { order.push("b2"); })
  .then(() => { order.push("b3"); })
  .then(() => { order.push("b4"); });
setTimeout(() => {
  console.log(order.join(" | "));
}, 20);
