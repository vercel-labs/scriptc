// process.stdin.ref()/unref(): Node's handle refcount on the stdin stream.
// Ink's App component keeps the process alive with these two calls. The
// harness gives the program a closed stdin, so both runtimes exit on their
// own; the pin is that the members exist, take no arguments, and that
// unref() does not make the stream unreadable.
// The untyped path a JavaScript dependency takes: the members through the
// stream's checked-dynamic view, which answers the receiver back.
const stream: any = process.stdin;
console.log(typeof stream.ref, typeof stream.unref);
stream.unref();
stream.ref();

// The typed path: statement-position calls, as Ink writes them.
process.stdin.unref();
process.stdin.ref();

// A consumer registered while unref'd does not keep the loop alive; the
// process still exits normally when stdin reaches its end.
process.stdin.on("end", () => {
  console.log("end");
});
process.stdin.unref();
console.log("done");
