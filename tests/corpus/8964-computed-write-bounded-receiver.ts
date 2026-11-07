// Writes with a computed key through typed receivers. A write through a
// Screen can replace a method of a Screen or of a class derived from it, and
// the call must see the replacement, as in Node. It cannot reach a Queue or
// a Store, whose method calls stay direct.
class Queue {
  private items: string[] = [];
  enqueue(item: string): void {
    this.items.push(item);
  }
  size(): number {
    return this.items.length;
  }
}

class Store {
  private value = "";
  withLock(scope: string, update: (current: string) => string): void {
    this.value = `${scope}:${update(this.value)}`;
  }
  read(): string {
    return this.value;
  }
}

class Screen {
  title = "first";
  draw(): string {
    return `[${this.title}]`;
  }
}

class Panel extends Screen {
  override draw(): string {
    return `<${this.title}>`;
  }
}

function forward(screen: Screen, property: string, value: unknown): boolean {
  return Reflect.set(screen, property, value, screen);
}

interface Options {
  depth: number;
  label: string;
}

function merge(options: Options, patch: Partial<Options>): Options {
  return Object.assign(options, patch);
}

const queue = new Queue();
queue.enqueue("a");
queue.enqueue("b");
const store = new Store();
store.withLock("global", (current) => current + "x");
const screen = new Screen();
const panel = new Panel();
console.log(queue.size(), store.read(), screen.draw(), panel.draw());

console.log(forward(screen, "title", "second"), forward(panel, "title", "third"));
console.log(screen.draw(), panel.draw());
console.log(forward(panel, "draw", () => "replaced"));
console.log(screen.draw(), panel.draw(), new Panel().draw());

const options = merge({ depth: 1, label: "a" }, { depth: 2 });
console.log(JSON.stringify(options));

queue.enqueue("c");
store.withLock("project", (current) => current.toUpperCase());
console.log(queue.size(), store.read());
