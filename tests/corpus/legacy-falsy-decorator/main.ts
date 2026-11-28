// @tsc-legacy-decorators
// A decorator expression that evaluates to undefined, null or false is
// SKIPPED by tsc's legacy helper (`if (d = decorators[i])`), for classes and
// for members; the program must not throw and the next decorator still runs.

function pickClass(use: boolean): any {
  return use
    ? (t: typeof A) => {
        console.log("class applied");
      }
    : undefined;
}

function pickMethod(use: boolean): any {
  return use
    ? (t: any, k: any, d: any) => {
        console.log("method applied", k);
      }
    : null;
}

@pickClass(false)
class A {}

class B {
  @pickMethod(false)
  m(): number {
    return 1;
  }

  @pickMethod(true)
  n(): number {
    return 2;
  }
}

console.log("after", A.name);
const b = new B();
console.log("calls", b.m(), b.n());
