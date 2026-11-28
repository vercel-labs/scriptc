// A stream subclass whose constructor name is longer than the runtime's type
// key buffer pipes into a destination whose 'pipe' listener keeps the source.
// The listener is untyped, so the event carries the source as a checked
// dynamic value and the runtime interns a type key built from the class name;
// a name that does not fit the key buffer must not read past it.
// Differentially vs Node and under the sanitizers.
import { Readable, Writable } from "node:stream";

class LongStreamSubclassWhoseConstructorNameExceedsTheKeyBufferLength extends Readable {
  _read(): void {
    this.push("chunk");
    this.push(null);
  }
}

const source = new LongStreamSubclassWhoseConstructorNameExceedsTheKeyBufferLength();
const sink = new Writable({
  write(_chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    callback();
  },
});
let kept: unknown = null;
const emitter: any = sink;
emitter.on("pipe", (stream: any) => {
  kept = stream;
});
source.pipe(sink);
setTimeout(() => {
  console.log("kept", kept === source, kept !== null);
  source.destroy();
  sink.destroy();
}, 10);
