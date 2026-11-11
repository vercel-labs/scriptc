// A native class that extends a class of a Node island, with optional and
// defaulted parameters on its constructor and methods. The island calls the
// constructor and the methods as JavaScript functions: an omitted argument
// arrives as undefined, a default is evaluated then (and only then), and the
// island base may call an overridden method with fewer arguments than it
// declares.
import { Packet, Tray } from "seed-kit";

let stamps = 0;
const stamp = (): string => "s" + ++stamps;

class Mix extends Packet {
  seeds: string[];
  constructor(seeds: string[], message?: string, shelf?: string) {
    super({ code: "MIX", message: message || "A mix of seeds.", shelf: shelf || "top" });
    this.seeds = seeds;
  }
  label(mark = "dflt", times = 1): string {
    return "[" + mark + ":" + times + "]";
  }
}

class Counted extends Packet {
  count: number;
  constructor(count = 3, message = stamp(), shelf: string = "mid") {
    super({ code: "CNT", message, shelf });
    this.count = count;
  }
  label(mark?: string, times?: number): string {
    return "<" + (mark ?? "none") + ":" + (times ?? 0) + ">";
  }
}

class Deep extends Tray {
  constructor(rows: number, cols?: number) {
    super(rows, cols ?? rows);
  }
  area(scale = 1, unit?: string): string {
    return String(this.rows * this.cols * scale) + (unit ?? "");
  }
  get cells(): number {
    return this.rows * this.cols;
  }
  visitAll(tag?: string): string {
    return this.each(function (row, t) {
      return String(row) + (t ?? tag ?? "-");
    });
  }
}

const a = new Mix(["pea"]);
const b = new Mix(["bean", "corn"], "Two kinds.", "low");
console.log(a.code, a.seeds.join("+"), a.message, a.shelf, a instanceof Mix, a instanceof Packet);
console.log(b.code, b.seeds.join("+"), b.message, b.shelf, b instanceof Error);
// The island base calls label() and label("x", 2); the program calls it too.
console.log(a.describe(), a.describe(">"), a.label(), a.label(undefined, 4), a.label("q", 5));

const c = new Counted();
const d = new Counted(7);
const e = new Counted(undefined, "Named.", undefined);
console.log(c.count, c.message, c.shelf, "|", d.count, d.message, "|", e.count, e.message, e.shelf);
console.log("stamps", stamps);
console.log(c.describe(), c.label("q"));

const f = new Deep(3);
const g = new Deep(2, 5);
console.log(f.size(), f.area(), f.area(2), f.area(2, "cm"), g.size(), g.area(undefined, "u"));
console.log(g.cells, g.visitAll(), g.visitAll("z"));

try {
  throw new Mix(["thrown"]);
} catch (err) {
  if (err instanceof Mix) console.log("caught", err.seeds[0], err.message, err.label());
}

// The class answers its constructor's length as Node counts it: the
// parameters before the first default.
console.log("lengths", Mix.length, Counted.length, Deep.length);
