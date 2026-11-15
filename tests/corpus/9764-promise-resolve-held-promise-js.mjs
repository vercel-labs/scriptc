// `Promise.resolve(v)` where `v` is and holds a promise answers that promise, and
// the resolve function of `Promise.withResolvers()` adopts a promise it is given.
let tick = 0;
function spin(i) {
  if (i < 12) {
    Promise.resolve().then(() => {
      tick++;
      spin(i + 1);
    });
  }
}
function note(label, p) {
  p.then(
    (v) => {
      console.log(label, "fulfilled", String(v), "tick", tick);
    },
    (e) => {
      console.log(label, "rejected", e instanceof Error ? e.message : String(e), "tick", tick);
    },
  );
}
function hide(v) {
  return v;
}
spin(0);
const held = Promise.resolve(3);
console.log("same promise", Promise.resolve(held) === held);
note("held fulfilled", Promise.resolve(held));
const failing = Promise.reject(new Error("r"));
note("held rejected", Promise.resolve(failing));
const plain = { a: 1 };
note("plain", Promise.resolve(plain).then((v) => JSON.stringify(v)));
const text = "text";
note("string", Promise.resolve(text));
const w = Promise.withResolvers();
note("withResolvers", w.promise);
w.resolve(hide(Promise.resolve(10)));
w.reject(new Error("late"));
w.resolve("second");
const w2 = Promise.withResolvers();
note("withResolvers rejected", w2.promise);
w2.reject(new Error("first"));
w2.resolve(hide(Promise.resolve(10)));
