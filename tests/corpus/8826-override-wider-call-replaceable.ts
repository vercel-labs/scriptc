// An override declares a parameter past the inherited method's arity, and
// the program also writes a key it cannot name at build time, so every method
// counts as replaceable. A call on the override's own type passes the extra
// argument to the override; a replaced method receives every argument too.
interface Options {
  weight?: number;
}
let defaults = 0;
function fallback(): Options {
  defaults++;
  return {};
}
class Box {
  kids: string[] = [];
  add(child: string): void {
    this.kids.push(child);
  }
  describe(prefix: string): string {
    return prefix + this.kids.join(",");
  }
}
abstract class Row extends Box {
  weights: number[] = [];
  constructor(children: (string | { child: string; weight?: number })[] = []) {
    super();
    for (const entry of children) {
      if (typeof entry === "string") this.add(entry);
      else this.add(entry.child, entry);
    }
  }
  override add(child: string, options: Options = fallback()): void {
    super.add(child);
    this.weights.push(options.weight ?? 0);
  }
  override describe(prefix: string, suffix?: string): string {
    return super.describe(prefix) + (suffix ?? "") + "|" + this.weights.join(",");
  }
}
class Plain extends Row {}

const plain = new Plain(["x", { child: "y", weight: 3 }]);
console.log(plain.describe("kids:"), defaults);
plain.add("z", { weight: 9 });
plain.add("u", undefined);
console.log(plain.describe("kids:", "!"), defaults);
const box: Box = plain;
box.add("w");
console.log(box.describe("kids:"), defaults);

// The write that makes method names replaceable: its key is a run-time value.
const bag: Record<string, unknown> = {};
const holder = { target: bag as any };
holder.target[process.argv.length > 99 ? "add" : "other"] = 1;
console.log(Object.keys(bag).join(","));

// A replacement installed on the instance takes the call and both arguments.
const replaced = new Plain();
(replaced as any).add = function (this: Plain, child: string, options?: Options): void {
  this.kids.push("replaced:" + child + ":" + (options?.weight ?? -1));
};
replaced.add("a", { weight: 4 });
replaced.add("b");
console.log(replaced.describe("kids:", "?"), defaults);
