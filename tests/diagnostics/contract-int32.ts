// Int32 contracts that do not hold: each write that is not an int32 by
// construction is reported with the expression and the `| 0` fix.
import type { Int32 } from "@scriptc/types";

class Span {
  pos: Int32 = 0;
  end: Int32 = 0;
  readonly id: Int32;
  constructor(id: number) {
    this.id = id;
  }
  advance(): void {
    this.pos++;
  }
}

function width(span: Span): Int32 {
  return span.end - span.pos;
}

function half(x: Int32): Int32 {
  return x / 2;
}

let count: Int32 = 0;
function bump(): void {
  count += 1;
}

const sizes = [1, 2, 3];
const len: Int32 = sizes.length;
const weights = [1.5, 2];
const shifted = weights.map((w: Int32) => w + 1);

const span = new Span(1.5);
span.advance();
bump();
console.log(width(span), half(7), count, len, shifted);
