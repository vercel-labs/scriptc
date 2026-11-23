// Reflect.construct's argument list is a value, not only a literal: named
// typed arrays, parameters and a member read into a variable all pass the
// values Node passes to the constructor.
function Sum(this: any, a: number, b: number) {
  this.total = a + b;
}
function Join(this: any, a: string, b: string) {
  this.text = a + b;
}
function Empty(this: any, a?: number) {
  this.missing = a === undefined;
}

const numbers: number[] = [1, 2];
console.log((Reflect.construct(Sum, numbers) as any).total);

const words: string[] = ['a', 'b'];
console.log((Reflect.construct(Join, words) as any).text);

function build(list: number[]): number {
  return (Reflect.construct(Sum, list) as any).total;
}
console.log(build([3, 4]));

const empty: number[] = [];
console.log((Reflect.construct(Empty, empty) as any).missing);

const held = Reflect.construct;
console.log((held(Sum, numbers) as any).total);

const holes: number[] = new Array<number>(2);
console.log((Reflect.construct(Empty, holes) as any).missing);
