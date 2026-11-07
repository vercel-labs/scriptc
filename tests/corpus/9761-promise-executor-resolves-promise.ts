// The resolve function of `new Promise` given a promise: the new promise adopts it (two turns
// later than a plain value), and from then on a second resolve, a reject and a throw of the
// executor change nothing. Values of type `unknown`, a typed promise, a resolve function that
// escapes the executor, and a promise resolved with itself.
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
note("fulfilled promise", new Promise((resolve) => { resolve(hide(Promise.resolve(7))); }));
note("rejected promise", new Promise((resolve) => { resolve(hide(Promise.reject(new Error("r")))); }));
note("typed promise", new Promise((resolve) => { resolve(Promise.resolve(8)); }));
note("plain", new Promise((resolve) => { resolve(hide("plain")); }));
const later = new Promise<number>((resolve) => { setTimeout(() => resolve(5), 1); });
note("pending promise", new Promise((resolve) => { resolve(hide(later)); }));
note("resolved twice", new Promise((resolve) => { resolve(hide(later)); resolve(hide("second")); }));
note("resolved then rejected", new Promise((resolve, reject) => { resolve(hide(later)); reject(new Error("late")); }));
note("resolved then thrown", new Promise((resolve) => { resolve(hide(later)); throw new Error("thrown"); }));
note("plain then promise", new Promise((resolve) => { resolve(hide("first")); resolve(hide(Promise.resolve(1))); }));
note("rejected then promise", new Promise((resolve, reject) => { reject(new Error("first")); resolve(hide(Promise.resolve(1))); }));
note("thrown before", new Promise((resolve) => { if (tick === 0) throw new Error("early"); resolve(hide(later)); }));
let saved: (value: unknown) => void = () => {};
note("saved resolve", new Promise((resolve) => { saved = resolve; }));
saved(hide(Promise.resolve(9)));
saved(hide("ignored"));
const self: Promise<unknown> = new Promise((resolve) => { setTimeout(() => { resolve(hide(self)); }, 10); });
note("itself", self);
const chain: Promise<unknown> = new Promise((resolve) => {
  resolve(hide(new Promise((inner) => { inner(hide(Promise.resolve("nested"))); })));
});
note("nested", chain);
