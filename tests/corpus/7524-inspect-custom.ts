// [util.inspect.custom] methods on classes: the method's string replaces
// the instance in util.inspect, console output and util.format, with
// Node's depth argument (negative past the depth limit, null for depth:
// null), options object and util.inspect; a multi-line result indents at
// its position, a returned value renders in the instance's place, and
// console.dir, customInspect: false, String() and JSON skip the method.
import * as util from "node:util";
import { inspect } from "node:util";

class Money {
  cents: number;
  constructor(cents: number) {
    this.cents = cents;
  }
  [inspect.custom](): string {
    return `Money(${(this.cents / 100).toFixed(2)})`;
  }
}

class Probe {
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  [util.inspect.custom](depth: number | null, options: util.InspectOptionsStylized): string {
    const keys = Object.keys(options).join(",");
    return `Probe<${this.label} depth=${depth} optionsDepth=${options.depth} compact=${options.compact}> ${keys}`;
  }
}

class Lines {
  [inspect.custom](): string {
    return "first line\nsecond line";
  }
}

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  [inspect.custom](): { x: number; y: number; sum: number } {
    return { x: this.x, y: this.y, sum: this.x + this.y };
  }
}

class Wrapper {
  inner: { values: number[]; nested: { deep: { deeper: number } } };
  constructor() {
    this.inner = { values: [1, 2, 3], nested: { deep: { deeper: 4 } } };
  }
  [inspect.custom](depth: number, options: util.InspectOptionsStylized, show: typeof inspect): string {
    if (depth < 0) return options.stylize("[Wrapper]", "special");
    return `Wrapper ${show(this.inner, { ...options, depth: options.depth == null ? null : depth - 1 })}`;
  }
}

class Base {
  name = "base";
  [inspect.custom](): string {
    return `Custom(${this.name})`;
  }
}
class Derived extends Base {
  extra = 1;
}

console.log(util.inspect(new Money(1234)));
console.log(new Money(5), [new Money(1), new Money(2)]);
console.log(util.inspect({ wallet: { cash: new Money(99) } }));
console.log(util.inspect(new Probe("top")));
console.log(util.inspect({ a: { b: new Probe("nested") } }));
console.log(util.inspect([new Probe("past depth")], { depth: 0 }));
console.log(util.inspect(new Probe("unbounded"), { depth: null }));
console.log(util.inspect(new Probe("infinite"), { depth: Infinity }));
console.log(util.inspect([new Probe("undefined")], { depth: undefined }));
console.log(util.inspect(new Probe("compact"), { compact: false, breakLength: 40 }));
console.log(util.inspect({ key: new Lines(), list: [new Lines()] }));
console.log(util.inspect(new Map([["k", new Lines()]])));
console.log(util.inspect(new Point(1, 2)), util.inspect({ p: new Point(3, 4) }));
console.log(util.inspect(new Wrapper()), util.inspect({ w: new Wrapper() }, { depth: 0 }));
console.log(util.inspect(new Derived()), util.inspect([new Base(), new Derived()]));
console.log(util.format("%s | %O", new Money(10), new Money(20)));
console.log("%s and %d", new Money(1), 2);
console.log(util.inspect(new Money(7), { customInspect: false }));
console.dir(new Money(8));
console.log(String(new Money(9)), JSON.stringify(new Money(10)));
const values: unknown[] = [new Money(11), { money: new Money(12) }];
console.log(values, util.inspect(values[1]), [new Lines(), values[0]]);
