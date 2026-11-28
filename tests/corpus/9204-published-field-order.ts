// A self-append on a published record field, a published class field, a
// this-field in a method and a field published in the constructor: the
// length check runs before the published write guard, as Node's
// right-hand-side order does. A small append still meets the write guard's
// TypeError.
"use strict";
import { publish } from "@scriptc/threads";

const half = "a".repeat(268435445);
console.log(half.length);

function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "built");
  } catch (error) {
    const e = error as Error;
    console.log(label, e.name, e.message);
  }
}

const rec: { s: string } = { s: half };
publish(rec);
attempt("record", () => {
  rec.s += half + "b";
});

class Holder {
  s: string;
  constructor(s: string) {
    this.s = s;
  }
}
const box = new Holder(half);
publish(box);
attempt("class field", () => {
  box.s += half + "b";
});

class Grower {
  s: string;
  constructor(s: string) {
    this.s = s;
  }
  grow(): void {
    this.s += half + "b";
  }
}
const grower = new Grower(half);
publish(grower);
attempt("this-field", () => {
  grower.grow();
});

class SelfPublishing {
  s: string;
  constructor(s: string) {
    this.s = s;
    publish(this);
    this.s += half + "b";
  }
}
attempt("constructor publish", () => {
  new SelfPublishing(half);
});

const smallRec: { s: string } = { s: "x" };
publish(smallRec);
attempt("small", () => {
  smallRec.s += "y";
});
