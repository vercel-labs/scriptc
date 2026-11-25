// An async generator's `yield v` and `return v` await `v`: a promise held in an untyped
// value is settled first, and its rejection throws at the yield.
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
async function* yields() {
  const sent = yield hide(Promise.resolve(1));
  console.log("sent", String(sent), "tick", tick);
  yield hide("plain");
  try {
    yield hide(Promise.reject(new Error("r")));
  } catch (e) {
    console.log("caught inside", e instanceof Error ? e.message : String(e), "tick", tick);
  }
  return hide(Promise.resolve("returned"));
}
function show(r) {
  return JSON.stringify(r);
}
async function drive() {
  const g = yields();
  console.log(show(await g.next()), "tick", tick);
  console.log(show(await g.next("in")), "tick", tick);
  console.log(show(await g.next()), "tick", tick);
  console.log(show(await g.next()), "tick", tick);
  console.log(show(await g.next()), "tick", tick);
  return "done";
}
async function* fails() {
  return hide(Promise.reject(new Error("returned rejection")));
}
note("drive", drive());
note("failing return", fails().next());
