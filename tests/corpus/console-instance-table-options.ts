// console.table renders its cells through Node's table _inspect: the
// table's own depth (0, or -1 for an object that is not an array and has
// more than two own keys), maxArrayLength 3 and breakLength Infinity, with
// the Console's inspectOptions spread over them, and colorMode (or the
// options' own colors) deciding the ANSI styling.
import { Console } from "node:console";
import { Writable } from "node:stream";

interface Sink { out: string }

function streamOf(sink: Sink): Writable {
  return new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      sink.out += String(chunk);
      cb();
    },
  });
}
function show(label: string, out: string): void {
  console.log(label, JSON.stringify(out));
}

// Default cells: an object with more than two own keys is past the depth
// limit and renders [Object]; an array shows three items and the count.
const plainSink: Sink = { out: "" };
new Console({ stdout: streamOf(plainSink) }).table([
  { a: { b: 1, c: 2, d: 3 }, n: 1 },
  { a: { b: 1, c: 2 }, xs: [1, 2, 3, 4, 5] },
]);
show("default cells", plainSink.out);

// depth overrides the table's computed depth.
const depthSink: Sink = { out: "" };
new Console({ stdout: streamOf(depthSink), inspectOptions: { depth: 2 } }).table([
  { a: { b: { c: 1 } } },
]);
show("depth cells", depthSink.out);

// maxArrayLength overrides the table's three.
const arraySink: Sink = { out: "" };
new Console({ stdout: streamOf(arraySink), inspectOptions: { maxArrayLength: 5 } }).table([
  { xs: [1, 2, 3, 4, 5] },
]);
show("array cells", arraySink.out);

// maxStringLength, sorted and breakLength reach the cells.
const stringSink: Sink = { out: "" };
new Console({ stdout: streamOf(stringSink), inspectOptions: { maxStringLength: 3 } }).table([
  { s: "abcdef" },
]);
show("string cells", stringSink.out);
const sortedSink: Sink = { out: "" };
new Console({ stdout: streamOf(sortedSink), inspectOptions: { sorted: true } }).table([
  { o: { b: 1, a: 2 } },
]);
show("sorted cells", sortedSink.out);
const breakSink: Sink = { out: "" };
new Console({ stdout: streamOf(breakSink), inspectOptions: { breakLength: 30 } }).table([
  { o: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 1, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: 2 } },
]);
show("break cells", breakSink.out);

// getters reaches the cells: off by default, on with the option.
const accessor = { get g(): number { return 7; } };
const accessorSink: Sink = { out: "" };
new Console({ stdout: streamOf(accessorSink) }).table([{ o: accessor }]);
const accessorOnSink: Sink = { out: "" };
new Console({ stdout: streamOf(accessorOnSink), inspectOptions: { getters: true } }).table([
  { o: accessor },
]);
show("accessor cells", accessorSink.out + accessorOnSink.out);

// colorMode true colors the cells; an explicit inspectOptions.colors wins
// over the 'auto' answer for a stream that is not a terminal.
const modeSink: Sink = { out: "" };
new Console({ stdout: streamOf(modeSink), colorMode: true }).table([{ s: "x", n: 1 }]);
show("mode cells", modeSink.out);
const explicitSink: Sink = { out: "" };
new Console({ stdout: streamOf(explicitSink), inspectOptions: { colors: true } }).table([
  { s: "x", n: 1 },
]);
show("explicit cells", explicitSink.out);

// The global console's table follows shouldColorize too: FORCE_COLOR
// colors a stdout that is not a terminal.
process.env.FORCE_COLOR = "1";
console.table([{ s: "x", n: 1 }]);
delete process.env.FORCE_COLOR;
