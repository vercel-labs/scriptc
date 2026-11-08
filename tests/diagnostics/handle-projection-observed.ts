// A process stream stored where a record type of methods is declared (an
// array element, a `let`, a method's parameter) is a separate record of
// those methods: calls through it reach the stream. Under Node the stored
// value is the stream itself, so a program that compares such a record with
// the stream, lists its keys, or hands it to untyped code is refused.
interface Sink {
  write(text: string): boolean;
}

const sinks: Sink[] = [process.stdout, process.stderr];
sinks[0]!.write("through the record\n");
console.log(sinks[0] === process.stdout);
const second = sinks[1]!;
console.log(second !== process.stderr);
console.log(Object.keys(second).length);

let current: Sink = process.stderr;
current = { write: () => true };
const untyped: unknown = current;
console.log(typeof untyped);
