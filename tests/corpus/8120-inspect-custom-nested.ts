// util.inspect and util.format calls inside [util.inspect.custom] methods
// start from their own defaults: no indentation from the outer render, the
// outer circular references kept, and no colors from the outer options.
import * as util from "node:util";

class Wide {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
  [util.inspect.custom](): string {
    return util.inspect({ a: { b: [1, 2, { c: this.v }] }, s: "x".repeat(50), t: "y".repeat(30) });
  }
}
console.log({ outer: { inner: new Wide(1) } });
type Holder = { first: Wide; list: Wide[]; self?: Holder };
const holder: Holder = { first: new Wide(2), list: [new Wide(3)] };
holder.self = holder;
console.log(holder);
console.log(util.inspect({ deep: { deeper: { c: new Wide(4) } } }));

const shared = { k: 1 };
class Shares {
  [util.inspect.custom](): string {
    return "S<" + util.inspect(shared) + ">";
  }
}
console.log({ a: shared, c: new Shares(), b: shared });
type Loop = { c: Shares; me?: Loop; again?: Loop };
const loop: Loop = { c: new Shares() };
loop.me = loop;
loop.again = loop;
console.log(loop);

class Formats {
  [util.inspect.custom](): string {
    return util.format("%s|%O|%o|%j|%d", "a", "b", "c", "d", 5);
  }
}
console.log(JSON.stringify(util.inspect(new Formats(), { colors: true })));
console.log(JSON.stringify(util.inspect({ f: new Formats() }, { colors: true })));

class Leaf {
  [util.inspect.custom](depth: unknown, options: any): string {
    return options.stylize("leaf", "special") + util.inspect({ z: 1, a: [1, 2] });
  }
}
class Branch {
  leaf = new Leaf();
  [util.inspect.custom](): string {
    return "B(" + util.inspect({ b: 2, a: { leaf: this.leaf, s: "q" } }) + ")";
  }
}
class Throws {
  [util.inspect.custom](): string {
    throw new Error("nope");
  }
}
const opts = { sorted: true, breakLength: 20, compact: false, colors: true };
console.log(JSON.stringify(util.inspect({ y: new Branch(), x: [new Leaf()] }, opts)));
console.log(util.inspect({ k: { j: new Branch() } }, { depth: 0 }));
try {
  console.log(util.inspect({ a: { b: new Throws() } }));
} catch (e) {
  console.log("caught", (e as Error).message);
}
console.log({ after: { deep: { x: 1 } }, list: [1, 2, 3] });
