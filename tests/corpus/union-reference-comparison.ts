class Base { value = 1; }
class Child extends Base { extra = 2; }
class Other { label = "other"; }

function compare(left: Child | undefined, right: Base | undefined): void {
  console.log(left === right, left !== right, Object.is(left, right));
  console.log(right === left, right !== left, Object.is(right, left));
}
const child = new Child();
compare(child, child);
compare(child, new Child());
compare(child, new Base());
compare(undefined, undefined);
compare(child, undefined);
compare(undefined, child);

function base(value: Base): Base { return value; }
function sameShape(left: Base | Child | undefined, right: Base | Child | undefined): void {
  console.log(left === right, left !== right, Object.is(left, right));
}
sameShape(child, base(child));
sameShape(base(child), child);
sameShape(child, new Base());

function structural(left: Base | { label: string }, right: Child): void {
  console.log(left === right, right !== left);
}
structural(child, child);
structural(new Child(), child);
structural({ label: "child" }, child);

function mixed(left: Child | string | undefined, right: Base | Other | null): void {
  console.log(left === right, left !== right, Object.is(left, right));
}
mixed(child, child);
mixed(child, new Other());
mixed("label", null);
mixed(undefined, null);

function primitives(left: number | string | undefined, right: number | boolean | null): void {
  console.log(left === right, left !== right, Object.is(left, right));
}
primitives(NaN, NaN);
primitives(-0, 0);
primitives(0, -0);
primitives(7, 7);
primitives("7", 7);
primitives(undefined, null);
primitives("false", false);

function big(left: bigint | undefined, right: bigint | string | null): void {
  console.log(left === right, left !== right, Object.is(left, right));
}
big(12345678901234567890n, BigInt("12345678901234567890"));
big(1n, 2n);
big(1n, "1");
big(undefined, null);

function callback(value: number): number { return value + 1; }
function callbacks(left: ((value: number) => number) | undefined,
  right: ((value: number) => number) | null): void {
  console.log(left === right, left !== right, Object.is(left, right));
}
callbacks(callback, callback);
callbacks(callback, (value: number): number => value + 2);
callbacks(undefined, null);

const events: string[] = [];
function left(): Child | undefined { events.push("left"); return child; }
function right(): Base | null { events.push("right"); return child; }
console.log(left() === right(), events.join(","));
events.length = 0;
console.log(left() !== right(), events.join(","));
events.length = 0;
console.log(Object.is(left(), right()), events.join(","));
