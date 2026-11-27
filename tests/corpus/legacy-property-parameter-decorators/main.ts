// @tsc-legacy-decorators
// Legacy property decorators (3 arguments, third undefined, truthy
// returns ignored by their void contract) and parameter decorators on
// constructors, instance methods and parameter-only methods: factories
// evaluate in tsc's array order, applications run in reverse, and
// constructor parameters apply with the class decorations.
function paramDec(label: string): (target: any, key: any, index: number) => void {
  console.log("factory-param", label);
  return (target: any, key: any, index: number): void => {
    console.log("param", label, typeof target, key === undefined ? "ctor" : String(key), index);
  };
}

function propDec(label: string): (target: any, key: any) => void {
  console.log("factory-prop", label);
  return function (target: any, key: any, descriptor?: unknown): void {
    console.log("prop", label, String(key), descriptor === undefined);
  };
}

function methodDec(label: string): (target: any, key: any, d: PropertyDescriptor) => void {
  console.log("factory-method", label);
  return (target: any, key: any, d: PropertyDescriptor): void => {
    console.log("method", label, String(key), typeof d.value);
  };
}

function classDec(label: string): (target: typeof Service) => void {
  console.log("factory-class", label);
  return (target: typeof Service): void => {
    console.log("class", label, target.name);
  };
}

class Dep {}

@classDec("cls")
class Service {
  @propDec("field")
  name = "svc";
  @propDec("staticField")
  static kind = (console.log("static init"), "K");

  constructor(
    @paramDec("ctor0") private dep: Dep,
    @paramDec("ctor1") private other: number,
  ) {}

  @methodDec("m")
  run(@paramDec("mp0") a: number, @paramDec("mp1") b: string): void {
    console.log("run", a, b, this.name, typeof this.dep, this.other);
  }

  solo(@paramDec("sp0") x: number): number {
    console.log("solo", x);
    return x;
  }
}

class OnlyCtor {
  constructor(@paramDec("only0") public x: number) {}
}

console.log("only", new OnlyCtor(1).x);

const s = new Service(new Dep(), 2);
s.run(1, "b");
console.log("solo-ret", s.solo(9));
console.log("statics", Service.kind, s.name);
