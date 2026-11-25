// A process stream flows into a NodeJS.WritableStream parameter directly;
// a narrower writer record has to be built over it. The record's write is a
// closure over process.stdout, so the object literal's shape matches the
// target and the call reaches the stream.
interface Sink {
  write(s: string): void;
}

function emit(sink: Sink, s: string): void {
  sink.write(s);
}

const sink: Sink = {
  write: (s: string) => {
    process.stdout.write(s);
  },
};

emit(sink, "wrapper ok\n");
