// Writable.write completion callbacks that take the error argument: null
// after a successful write, the _write failure, ERR_STREAM_WRITE_AFTER_END
// after end(), and ERR_STREAM_DESTROYED after destroy(). Node orders the
// callback and the 'error' event through its writable state machine; this
// program prints both.
import { Writable } from "node:stream";

function show(label: string): (error?: Error | null) => void {
  return (error) => {
    const code = error ? (error as NodeJS.ErrnoException).code : undefined;
    console.log(
      label,
      error === null ? "null" : error === undefined ? "undefined" : `${code ?? ""} ${error.message}`,
    );
  };
}

const sink = new Writable({
  write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    callback(chunk.toString() === "bad" ? new Error("rejected") : null);
  },
});
sink.on("error", (error) => console.log("error event", error.message));
sink.write("good", show("good"));
sink.write("bad", show("bad"));

const ended = new Writable({
  write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    callback();
  },
});
ended.on("error", (error) =>
  console.log("ended error event", (error as NodeJS.ErrnoException).code),
);
ended.write("first", show("first"));
ended.end();
ended.write("late", show("late"));

const destroyed = new Writable({
  write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    callback();
  },
});
destroyed.destroy();
destroyed.write("after destroy", show("destroyed"));

// A callback declared without parameters keeps its current lowering.
const plain = new Writable({
  write(_chunk: Buffer, _encoding: string, callback: () => void): void {
    callback();
  },
});
plain.write("x", () => console.log("plain done"));

// Callbacks that return a value: the stream discards it.
let count = 0;
const counted = (): number => ++count;
plain.write("y", counted);
const tally = (error?: Error | null): number => (error ? -1 : ++count);
const counting = new Writable({
  write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    callback(null);
  },
});
counting.write("tally", tally);
setTimeout(() => console.log("count", count), 5);
