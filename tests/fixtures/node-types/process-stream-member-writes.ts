// `write` assigned through a stored process stream, typed by @types/node:
// the replacement is seen by every writer of that stream, the stream's
// `write` reads back as what was assigned, and the original is put back.
// A member the stream object does not keep is assigned in a function this
// program never calls: the statement compiles.

// Counts the writes a stream receives between start() and stop().
class Tally {
  writes = 0;
  private readonly out: NodeJS.WriteStream;
  private readonly original: NodeJS.WriteStream["write"];

  constructor(out: NodeJS.WriteStream) {
    this.out = out;
    this.original = out.write;
  }

  start(): void {
    const tally = this;
    function counted(text: string | Uint8Array): boolean {
      tally.writes += 1;
      return tally.original.call(tally.out, text);
    }
    this.out.write = counted;
  }

  stop(): void {
    this.out.write = this.original;
  }

  running(): boolean {
    return this.out.write !== this.original;
  }
}

const out = new Tally(process.stdout);
console.log("before", out.running());
out.start();
console.log("through console");
process.stdout.write("through the stream\n");
const held: NodeJS.WriteStream = process.stdout;
held.write("through a stored stream\n");
const during = out.running();
out.stop();
console.log("after", during, out.running(), out.writes);

// Each stream has its own write.
const err = new Tally(process.stderr);
err.start();
out.start();
console.error("to stderr");
console.log("to stdout");
out.stop();
err.stop();
console.log(out.writes, err.writes);

function widen(target: NodeJS.WriteStream): void {
  target.columns = 132;
}
console.log(typeof widen);
