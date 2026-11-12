// Function.prototype.toString over the program's own functions: Node strips
// the TypeScript syntax and prints what is left, every erased character
// standing as a space. A boxed function value reaches the text through
// String(), a template literal, Array.prototype.join and toString().

export function exported(a: number): number {
  return a;
}
const exportedValue: any = exported;
console.log(String(exportedValue));

function defaults(a: number, b: string = "x", ...rest: number[]): string {
  return `${a}${b}${rest.length}`;
}
const defaultsValue: any = defaults;
console.log(defaultsValue.toString());

function optional(a: number, b?: string): string | undefined {
  return b;
}
const optionalValue: unknown = optional;
console.log(`${optionalValue}`);

function generic<T, U extends object>(x: T, y?: U): T {
  return x;
}
const genericValue: any = generic;
console.log(String(genericValue));

const arrow = (a: number, b?: string): number => a * 2;
const arrowValue: any = arrow;
console.log(arrowValue.toString());

const genericArrow = <T,>(x: T): T => x;
const genericArrowValue: any = genericArrow;
console.log(String(genericArrowValue));

const funcExpr = function named(this: { n: number }, x: number): number {
  return x;
};
const funcExprValue: any = funcExpr;
console.log(funcExprValue.toString());

const asserted = (a: string) => a as unknown as string;
const assertedValue: any = asserted;
console.log(String(assertedValue));

const nonNull = (a: string | undefined) => a!;
const nonNullValue: any = nonNull;
console.log(String(nonNullValue));

const satisfied = ((a: string) => a) satisfies (a: string) => string;
const satisfiedValue: any = satisfied;
console.log(satisfiedValue.toString());

function assertions(x: unknown): asserts x is string {}
const assertionsValue: any = assertions;
console.log(assertionsValue.toString());

function destructured({ a }: { a: number }, [b]: [string]): string {
  return `${a}${b}`;
}
const destructuredValue: any = destructured;
console.log(String(destructuredValue));

function* counter(start: number): Generator<number> {
  yield start;
}
const counterValue: any = counter;
console.log(String(counterValue));

const asyncArrow = async (a: number): Promise<number> => a;
const asyncArrowValue: any = asyncArrow;
console.log(String(asyncArrowValue));

function overload(a: number): number;
function overload(a: string): string;
function overload(a: any): any {
  return a;
}
const overloadValue: any = overload;
console.log(String(overloadValue));

class Base<T> {
  hidden = 1;
  m(x: number): number {
    return x;
  }
}

abstract class AbstractBase extends Base<number> implements Iterable<number> {
  abstract other(): void;
  private privateField = 3;
  readonly fixed: number = 2;
  static make(): AbstractBase {
    return new Concrete();
  }
  m(x: number): number {
    return x + this.privateField + this.fixed;
  }
  *[Symbol.iterator](): Iterator<number> {
    return;
  }
}

class Concrete extends AbstractBase {
  other(): void {}
}

const instance = Concrete.make();
const methodValue: any = instance.m;
console.log(String(methodValue));

const staticValue: any = Concrete.make;
console.log(String(staticValue));

const key = "computed";
class Named {
  "quoted"(a: number): number {
    return a;
  }
  0(a: number): number {
    return a;
  }
  [key](a: number): number {
    return a;
  }
}
const named: any = new Named();
console.log(String(named.quoted));
console.log(String(named[0]));
console.log(String(named[key]));

const literalObject = {
  method(a: number): number {
    return a;
  },
  arrow: (a: number): number => a,
};
const literalMethod: any = literalObject.method;
const literalArrow: any = literalObject.arrow;
console.log(String(literalMethod));
console.log(String(literalArrow));

function outer(a: number): number {
  function inner(b: number): number {
    return b + a;
  }
  const innerValue: unknown = inner;
  console.log(String(innerValue));
  return a;
}
outer(1);

const list: any[] = [arrowValue, genericValue, defaultsValue];
console.log(list.join(" | "));
