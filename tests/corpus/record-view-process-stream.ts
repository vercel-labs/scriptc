// A process stream bound to a record type is a view of the stream: the
// binding holds the stream's descriptor, so writes through the record reach
// stdout, identity with `process.stdout` holds, and a parameter typed by the
// record receives the same stream.

interface Sink {
  write(text: string): void;
}

const sink: Sink = process.stdout;
sink.write("first write\n");
console.log(sink === process.stdout, sink !== process.stderr);

function emit(out: Sink, text: string): void {
  out.write(text);
}
emit(sink, "through a parameter\n");
emit(process.stdout, "straight through\n");
