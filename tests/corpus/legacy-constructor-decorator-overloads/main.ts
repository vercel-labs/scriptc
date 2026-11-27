// @tsc-legacy-decorators
// A constructor with overload signatures: the parameter decorators live on
// the implementation (with a body), so their factories and applications run
// even though the first constructor declaration is a signature.

function p(label: string): (t: object, k: string | symbol | undefined, i: number) => void {
  console.log("factory", label);
  return (t: object, k: string | symbol | undefined, i: number): void => {
    console.log("apply", label, i);
  };
}

class C {
  constructor(x: string | number);
  constructor(@p("impl") public x: string | number) {}
}

console.log("new", new C(1).x);
