// An object literal whose accessor or method reads `this` needs a live
// receiver: it has to see its own members at call time. A homomorphic mapped
// view of a class, or of an intersection, names that receiver through the
// view, and neither source can carry the view marking (a class instance keeps
// its own representation, an intersection has no symbol). The view type keeps
// checked identity, so the accessor runs per read and enumeration and JSON see
// it, as Node does.

class Box {
  width = 0;
  height = 0;
}

const boxed: Partial<Box> = {
  width: 3,
  get height() {
    return this.width! * 2;
  },
};
console.log(boxed.width, boxed.height);
console.log(Object.keys(boxed).join(","), JSON.stringify(boxed));
boxed.width = 5;
console.log(boxed.height);

class Counter {
  n = 0;
  bump(): number {
    return ++this.n;
  }
}

const counter: Pick<Counter, "n" | "bump"> = {
  n: 5,
  bump() {
    return this.n + 1;
  },
};
console.log(counter.bump(), counter.n, Object.keys(counter).join(","));
console.log(JSON.stringify(counter));

interface Left {
  a: number;
}
interface Right {
  b: number;
}
type Half = Partial<Left & Right>;

const half: Half = {
  a: 4,
  get b() {
    return this.a! + 1;
  },
};
console.log(half.a, half.b, Object.keys(half).join(","), JSON.stringify(half));
