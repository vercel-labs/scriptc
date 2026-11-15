// `promise.finally(callback)` waits for a promise the callback returns and rejects with its
// rejection; a plain result is dropped.
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
note("finally rejected", Promise.resolve("kept").finally(() => Promise.reject(new Error("r"))));
note("finally fulfilled", Promise.resolve("kept").finally(() => Promise.resolve("dropped")));
note("finally dyn rejected", Promise.resolve("kept").finally(() => hide(Promise.reject(new Error("d")))));
note("finally after rejection", Promise.reject(new Error("first")).finally(() => Promise.reject(new Error("second"))));
note("finally plain", Promise.resolve("kept").finally(() => 5));
const slow = new Promise((resolve) => { setTimeout(() => resolve("slow"), 1); });
note("finally waits", Promise.resolve("kept").finally(() => slow));
function failing() {
  return Promise.reject(new Error("seed"));
}
function again() {
  return Promise.reject(new Error("again"));
}
note("catch rejected", failing().catch(() => again()));
note("catch fulfilled", failing().catch(() => Promise.resolve("fallback")));
let count = 0;
note("finally counts", Promise.resolve("kept").finally(() => count++));
note("finally async", Promise.resolve("kept").finally(async () => { throw new Error("async"); }));
function cleanup() {
  return new Promise((resolve) => { setTimeout(() => { console.log("cleaned up"); resolve(undefined); }, 1); });
}
note("finally cleanup", Promise.resolve("kept").finally(() => cleanup()));
note("finally named", Promise.resolve("kept").finally(cleanup));
