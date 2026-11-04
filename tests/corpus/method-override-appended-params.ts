// An override may APPEND parameters: it still accepts every base call, so a
// base-typed receiver keeps the inherited call ABI. The appended slots take
// their own defaults when the caller omits them, and receive the explicit
// value when a subclass-typed receiver passes one.
interface Entry {
  kind: string;
}
interface Options {
  basis: number;
  grow: number;
}

class Container {
  protected readonly entries: Entry[] = [];
  add(child: Entry): void {
    this.entries.push(child);
  }
  addWithNote(child: Entry, note?: string): string {
    this.entries.push(child);
    return `${note ?? "-"}:${this.entries.length}`;
  }
  count(): number {
    return this.entries.length;
  }
}

class Stack extends Container {
  private readonly weights: number[] = [];
  override add(child: Entry, options: Options = { basis: 1, grow: 2 }): void {
    super.add(child);
    this.weights.push(options.basis + options.grow);
  }
  override addWithNote(child: Entry, note: string = "defaulted"): string {
    this.entries.push(child);
    return `${note}:${this.entries.length}`;
  }
  sum(): number {
    return this.weights.reduce((a, b) => a + b, 0);
  }
  kinds(): string {
    return this.entries.map((entry) => entry.kind).join("");
  }
}

function fill(container: Container, entry: Entry): void {
  container.add(entry);
}

const stack = new Stack();
fill(stack, { kind: "a" });
stack.add({ kind: "b" }, { basis: 10, grow: 20 });
const base: Container = stack;
base.add({ kind: "c" });
stack.add({ kind: "e" }, { basis: 0, grow: 0 });
console.log(stack.count(), stack.sum(), stack.kinds());

console.log(base.addWithNote({ kind: "f" }));
console.log(stack.addWithNote({ kind: "g" }, "explicit"));
console.log(stack.addWithNote({ kind: "h" }, undefined));
console.log(base.addWithNote({ kind: "i" }, "via-base"));
