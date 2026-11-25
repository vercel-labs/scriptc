// An object pattern whose source is a process stream reads each member as
// the member expression would: a binding of a terminal member (isTTY,
// columns, rows) can be undefined, at module level and in a function, and a
// default applies when it is. The corpus runs with piped streams, so every
// terminal member here is absent.
import type { WriteStream } from "node:tty";

const { isTTY, fd } = process.stdout;
let { columns, rows } = process.stderr;

function show(label: string, value: boolean | number | undefined): void {
  console.log(label, typeof value, value === undefined ? "absent" : String(value));
}

show("isTTY", isTTY);
show("fd", fd);
show("columns", columns);
show("rows", rows);
columns = 96;
rows = columns / 4;
show("columns", columns);
show("rows", rows);

// A parameter of the stream type, a pattern in the parameter list, and a
// source that is a call result (evaluated once).
function ruleWidth(paper: WriteStream): number {
  const { columns: width = 64, isTTY: glossy = false } = paper;
  return glossy ? width : width / 2;
}
function margins({ columns: width, fd: descriptor }: WriteStream): string {
  return String(width === undefined ? "none" : width) + "@" + String(descriptor);
}
let asked = 0;
function paper(): WriteStream {
  asked++;
  return asked % 2 === 1 ? process.stdout : process.stderr;
}
console.log(ruleWidth(process.stdout), ruleWidth(process.stderr));
console.log(margins(process.stdout), margins(process.stderr));
const { fd: first, writableLength, writableHighWaterMark, writableNeedDrain } = paper();
const { fd: second, isTTY: secondTty } = paper();
console.log(first, second, asked, secondTty === undefined, writableLength, writableHighWaterMark, writableNeedDrain);

// The bindings are ordinary values afterwards: captured, compared, defaulted.
const describe = (): string => (isTTY ? "terminal" : "plain") + "/" + String(columns ?? 0);
console.log(describe());
const loud = process.argv.length > 9;
const { fd: slot, rows: height = 24 } = loud ? process.stderr : process.stdout;
console.log(slot, height);

// process.stdin is the stream object itself; its terminal members are
// absent on a pipe too.
const { isTTY: keyboard, isRaw, fd: input } = process.stdin;
show("stdin isTTY", keyboard);
show("stdin isRaw", isRaw);
show("stdin fd", input);
