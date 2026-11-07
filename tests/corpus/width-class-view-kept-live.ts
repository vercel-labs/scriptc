// @transform-types
// An instance reaches an interface through something other than a call
// argument, or the callee keeps the value past the call: the interface keeps
// the live view, so a write to the instance is read back through it.
interface Tally {
  n: number;
}

class Counter {
  constructor(public n: number) {}
  bump(): void {
    this.n += 1;
  }
}

// A binding holds the view itself.
const counter = new Counter(1);
const view: Tally = counter;
counter.bump();
console.log(view.n);

function read(t: Tally): number {
  return t.n;
}
console.log(read(view), read(counter));

// The callee returns a function that reads the parameter later.
interface Readout {
  n: number;
}

class Gauge {
  constructor(public n: number) {}
  raise(): void {
    this.n += 10;
  }
}

function hold(r: Readout): () => number {
  return () => r.n;
}

const gauge = new Gauge(1);
const held = hold(gauge);
gauge.raise();
console.log(held());

// The callee returns the parameter itself.
interface Snapshot {
  n: number;
}

class Dial {
  constructor(public n: number) {}
  turn(): void {
    this.n *= 3;
  }
}

function pass(s: Snapshot): Snapshot {
  return s;
}

const dial = new Dial(2);
const alias = pass(dial);
dial.turn();
console.log(alias.n, dial.n);
