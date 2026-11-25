// Timeout.close() is Node's legacy cancel: clearTimeout(this), returning the
// handle so calls chain, and it stays silent on an already-cleared handle.
// Symbol.toPrimitive yields the numeric id clearTimeout accepts, and
// Symbol.dispose clears both Timeout and Immediate, twice-over included.
// Order-only: every timer here is cleared before its turn.
let fired = 0;
const a = setTimeout(() => fired++, 5);
console.log("prim", typeof Number(a), a[Symbol.toPrimitive]() === Number(a));
const same = a.close();
console.log("close chain", same === a);
a.close();
const b = setTimeout(() => fired++, 5);
b[Symbol.dispose]();
b[Symbol.dispose]();
const c = setImmediate(() => fired++);
c[Symbol.dispose]();
const d = setTimeout(() => fired++, 5);
clearTimeout(Number(d));
const e = setInterval(() => fired++, 5);
e.close();
const f = setTimeout(() => fired++, 5).unref();
f.close();
let ticks = 0;
const g = setInterval(() => {
  ticks++;
  g.close();
  console.log("interval stopped", ticks);
}, 1);
setTimeout(() => console.log("fired", fired), 20);
