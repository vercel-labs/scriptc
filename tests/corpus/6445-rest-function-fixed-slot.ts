// A rest-parameter function in a slot with fixed parameters: the slot's
// arguments arrive in the rest array, as in a JavaScript call.
function log(...messages: string[]): void {
  console.log(`log(${messages.length}):`, messages.join(" | "));
}
function tagged(tag: string, ...values: number[]): number {
  console.log(tag, values.join(","));
  return values.length;
}

class Line {
  private readonly sink: (m: string) => void;
  constructor(sink: (m: string) => void) {
    this.sink = sink;
  }
  emit(m: string): void {
    this.sink(m);
  }
}

new Line(log).emit("one");
const pair: (a: string, b: string) => void = log;
pair("x", "y");
const none: () => void = log;
none();
const count: (tag: string, a: number, b: number) => number = tagged;
console.log("count", count("t", 1, 2));
["a", "b"].forEach((m) => new Line(log).emit(m));

// Nullable and optional slots: the value takes the slot's function arm.
class OptionalLine {
  private readonly sink: ((m: string) => void) | null;
  constructor(sink: ((m: string) => void) | null) {
    this.sink = sink;
  }
  emit(m: string): void {
    if (this.sink) this.sink(m);
    else console.log("no sink:", m);
  }
}
new OptionalLine(log).emit("nullable");
new OptionalLine(null).emit("dropped");
function relay(m: string, sink?: (m: string) => void): void {
  sink?.(m);
}
relay("optional", log);
relay("absent");
const maybe: ((a: string, b: string) => void) | undefined = log;
maybe?.("p", "q");
