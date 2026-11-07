// A spread merge typed as a record union keeps the keys of its sources. The
// merge literal answers its discriminant, so the value is written through
// the matching arm; the arm conversion must keep the keys that arm does not
// declare, both for the reflective surfaces and for a later write to a
// declared field. Node keeps "x" from p in the merged y value, and it
// survives m.y = 42.
interface Inner {
  v: number;
}
interface X {
  kind: "x";
  inner: Inner;
  x?: number;
}
interface Y {
  kind: "y";
  inner: Inner;
  y?: number;
}
type XY = X | Y;

const p: XY = { kind: "x", inner: { v: 1 }, x: 2 };
const q: XY = { kind: "y", inner: { v: 9 }, y: 3 };

const m = { ...p, ...q } as XY;
console.log("before", JSON.stringify(m));
if (m.kind === "y") {
  console.log("hasX", "x" in m, "hasY", "y" in m);
  m.y = 42;
  console.log("after write", JSON.stringify(m));
  console.log("hasX after", "x" in m);
}
console.log("plain copy", JSON.stringify(q));
