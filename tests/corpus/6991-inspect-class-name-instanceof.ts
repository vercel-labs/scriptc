// util.inspect prints a class instance with its class's name, also when
// the program tests `instanceof` on unknown values (which gives the class
// a runtime prototype object).

class Leaf {
  x = 1;
  twin: Leaf | undefined = undefined;
}
class Branch extends Leaf {
  label = "b";
  describe(): string {
    return `branch ${this.label}`;
  }
}
class Plain {
  y = 2;
}

const solo = new Leaf();
const branch = new Branch();
console.log(solo);
console.log(branch, branch.describe());
console.log([solo, branch], { solo });
console.log(new Plain());

const boxed: unknown[] = [solo, branch, new Plain(), 3];
console.log(boxed.map((v) => (v instanceof Leaf ? "L" : String(v instanceof Plain))).join(","));
console.log(boxed.map((v) => (v instanceof Branch ? "B" : "-")).join(","));

solo.twin = branch;
console.log(solo);
