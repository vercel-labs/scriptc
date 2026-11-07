// `Promise.resolve(v)` where `v` is typed `any` and holds a promise answers that promise, and
// the resolve function of `Promise.withResolvers()` adopts a promise it is given.
let tick = 0;
function spin(i: number): void {
  if (i < 12) {
    Promise.resolve().then(() => {
      tick++;
      spin(i + 1);
    });
  }
}
function note(label: string, p: Promise<unknown>): void {
  p.then(
    (v) => {
      console.log(label, "fulfilled", String(v), "tick", tick);
    },
    (e) => {
      console.log(label, "rejected", e instanceof Error ? e.message : String(e), "tick", tick);
    },
  );
}
function hide(v: unknown): unknown {
  return v;
}
spin(0);
const held: any = Promise.resolve(3);
console.log("same promise", Promise.resolve(held) === held);
note("held fulfilled", Promise.resolve(held));
const failing: any = Promise.reject(new Error("r"));
note("held rejected", Promise.resolve(failing));
const plain: any = { a: 1 };
note("plain", Promise.resolve(plain).then((v) => JSON.stringify(v)));
const text: unknown = "text";
note("string", Promise.resolve(text));
const w = Promise.withResolvers<unknown>();
note("withResolvers", w.promise);
w.resolve(hide(Promise.resolve(10)));
w.reject(new Error("late"));
w.resolve("second");
const w2 = Promise.withResolvers<unknown>();
note("withResolvers rejected", w2.promise);
w2.reject(new Error("first"));
w2.resolve(hide(Promise.resolve(10)));
