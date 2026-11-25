// A method replaced by an own property of one instance, through writes the
// compiler cannot bound: the call sees the replacement on that instance and
// the declared method on every other one, as in Node.
class Meter {
  private total = 0;
  add(n: number): number {
    this.total += n;
    return this.total;
  }
  label(): string {
    return `meter ${this.total}`;
  }
}

class Gauge extends Meter {
  override label(): string {
    return `gauge ${this.add(0)}`;
  }
}

function put(target: any, key: string, value: unknown): void {
  target[key] = value;
}

function drop(target: any, key: string): void {
  delete target[key];
}

function assign(target: any, source: any): void {
  Object.assign(target, source);
}

function set(target: any, key: string, value: unknown): boolean {
  return Reflect.set(target, key, value);
}

function define(target: any, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, configurable: true });
}

const first = new Meter();
const second = new Meter();
const gauge = new Gauge();
const meters: Meter[] = [first, second, gauge];

// Before any write: every call is the declared method.
let sum = 0;
for (let i = 0; i < 1000; i++) sum += first.add(1) + second.add(2);
console.log(sum, first.label(), second.label(), gauge.label());

// Replaced after the first calls, on one instance.
put(first, "add", function (this: Meter, n: number): number {
  return -n;
});
console.log(first.add(5), second.add(5), gauge.add(5));

// Through an alias of the instance and an alias of the writer.
const alias: unknown = second;
const write = put;
write(alias, "label", () => "patched label");
console.log(first.label(), second.label(), gauge.label());
console.log(meters.map((meter) => meter.label()).join(" | "));

// Deleted again: the declared method is back.
drop(first, "add");
drop(alias, "label");
console.log(first.add(1), second.label());

// An override below the static type, replaced on the instance.
put(gauge, "label", () => "patched gauge");
console.log(meters.map((meter) => meter.label()).join(" | "));
drop(gauge, "label");
console.log(gauge.label());

// Reflective writes.
assign(first, { add: (n: number) => n * 100 });
console.log(first.add(2), second.add(2));
console.log(set(second, "add", (n: number) => n * 1000), first.add(3), second.add(3));
define(gauge, "add", (n: number) => n + 0.5);
console.log(gauge.add(1), gauge.label());
drop(first, "add");
drop(second, "add");
drop(gauge, "add");
console.log(first.add(1), second.add(1), gauge.add(1));

// The callee is read before the arguments run: a replacement made by an
// argument takes effect from the next call.
function replaceThenFive(target: Meter): number {
  put(target, "add", (n: number) => n * 7);
  return 5;
}
const third = new Meter();
console.log(third.add(replaceThenFive(third)), third.add(5));

// A property that is not a function.
put(third, "add", undefined);
try {
  third.add(1);
  console.log("called");
} catch (error) {
  console.log(error instanceof TypeError);
}
drop(third, "add");
console.log(third.add(1));

// An unrelated own property leaves the methods alone.
put(second, "note", "n");
console.log(second.add(1), (second as any).note);
