// A method that reads its own `this` makes its object literal a live-object
// view (wave-2 3b = A): the literal lowers as a checked-dynamic object and
// the method keeps JavaScript's own receiver rule — the call's receiver,
// `undefined` when detached, the other object when the method is copied.
// Both shapes pi's rpc-mode.ts hit are here: a contextual interface whose
// `label` member the literal implements with a getter (a member-kind
// disagreement, records 1 = B) and a plain method-only interface.
interface Labelled {
  readonly label: string;
  paste(text: string): void;
  setText(text: string): void;
}

const log: string[] = [];

const makeLabelled = (): Labelled => ({
  get label() {
    return "rpc";
  },
  paste(text: string): void {
    this.setText(text);
  },
  setText(text: string): void {
    log.push(text);
  },
});

const ui = makeLabelled();
ui.paste("a");
const detached = ui.paste;
try {
  detached("b");
} catch (e) {
  console.log("detached:", e instanceof TypeError);
}
console.log(log.join(","), ui.label);

interface Sink {
  send(text: string): void;
  record(text: string): void;
}

const makeSink = (): Sink => ({
  send(text: string): void {
    this.record(text);
  },
  record(text: string): void {
    log.push("sink:" + text);
  },
});

const sink = makeSink();
sink.send("c");
const other: Sink = { send: sink.send, record: (t) => log.push("other:" + t) };
other.send("d");
console.log(log.join(","));

// `this` also reaches a data member, and the receiver is the value the call
// goes through rather than the literal the method was written in.
interface Counter {
  n: number;
  bump(): number;
}
const counter: Counter = {
  n: 1,
  bump(): number {
    return ++this.n;
  },
};
const alias = counter;
console.log(alias.bump(), counter.n);
