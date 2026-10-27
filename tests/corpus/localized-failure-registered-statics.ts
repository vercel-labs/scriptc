// Localized failure, stage L2: a class that registers with dynamic slots
// runs its static field initializers where its statement evaluates, and a
// generic class's static methods compile once it registers.
type Progress = (done: number, total: number) => void;
type Callbacks = Progress | AbortSignal | Map<string, (x: number) => string> | Set<number>;

function sideEffect(label: string): number {
  console.log("static init", label);
  return label.length;
}

// Registers at its statement: the initializers run before the next line.
class Registry {
  state: any = { n: 1 };
  static count = sideEffect("registry");
  static names: string[] = ["a", "b"];
  read(): number {
    return this.state.n;
  }
}

console.log("after the class statement");

// Never referenced: its initializer runs all the same.
class Unused {
  slot: any = null;
  static ready = sideEffect("unused");
}

// A generic class whose static method has a dynamic parameter.
class Box<T> {
  value: T;
  constructor(v: T) {
    this.value = v;
  }
  static describe(target: Callbacks | undefined): string {
    return target === undefined ? "none" : typeof target;
  }
  static label(): string {
    return "box";
  }
}

const r = new Registry();
console.log(r.read(), Registry.count, Registry.names.join(","));
console.log(Box.label(), Box.describe(undefined), Box.describe(new Set([1])), new Box(3).value);
