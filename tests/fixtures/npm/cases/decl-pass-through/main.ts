// Package functions declared to return their argument's own type
// (`<T extends object>(obj: T) => T`) hand back the argument, or a proxy
// standing in for it, and the package tracks that object's identity: those
// results stay the package's objects. Reads of data the declarations
// describe (`point(): Point`) are still typed.
import { byReference, equals, mark, point } from "ref-marks";

const a = byReference({ n: 42 });
const b = byReference({ n: 42 });
console.log(equals(a, a), equals(a, b), a.n + b.n);
const m = mark({ n: 1 });
const m2 = mark({ n: 1 });
console.log(equals(m, m), equals(m, m2));
const p = point(1, 2);
const q = point(1, 2);
console.log(equals(p, q), p.x + q.y);
