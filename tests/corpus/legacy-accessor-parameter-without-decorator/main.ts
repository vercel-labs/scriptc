// @tsc-legacy-decorators
// tsc emits no decoration for an accessor pair that has no member
// decorator, even when the setter's parameter carries decorators: the
// parameter decorator expressions never run. The compiled program must
// match, and the accessor itself works normally.

function p(label: string): (t: object, k: string | symbol | undefined, i: number) => void {
  console.log("factory-param", label);
  return (t: object, k: string | symbol | undefined, i: number): void => {
    console.log("param", label, i);
  };
}

class C {
  private v = 0;

  set x(@p("s") value: number) {
    this.v = value;
    console.log("set", value);
  }

  get x(): number {
    return this.v;
  }
}

const c = new C();
c.x = 5;
console.log("v", c.x);
