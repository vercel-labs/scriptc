// A member of a standard stream read through an optional chain answers as
// the plain read does. The terminal members (isTTY, columns, rows) are
// declared boolean and number, and a stream has them only on a terminal:
// the corpus runs with piped streams, so each of them is undefined here in
// every form (read, compared, defaulted, negated, tested, passed on, stored,
// bound by a pattern), whether the receiver is the standard stream, an
// alias of it, or a stream that may be undefined. `fd` is always there.

function show(label: string, value: boolean | number | undefined): void {
  console.log(label, typeof value, value === undefined ? "absent" : String(value));
}

function wants(value: boolean): string {
  return typeof value + ":" + String(value);
}

function pick(which: string): typeof process.stdout | undefined {
  return which === "out" ? process.stdout : which === "err" ? process.stderr : undefined;
}

function input(have: boolean): typeof process.stdin | undefined {
  return have ? process.stdin : undefined;
}

show("stdin?.isTTY", process.stdin?.isTTY);
show("stdout?.isTTY", process.stdout?.isTTY);
show("stderr?.isTTY", process.stderr?.isTTY);
show("stdout?.columns", process.stdout?.columns);
show("stderr?.rows", process.stderr?.rows);
show("stdin?.fd", process.stdin?.fd);
show("stdout?.fd", process.stdout?.fd);
show("stderr?.fd", process.stderr?.fd);

console.log("compared", process.stdin?.isTTY === true, process.stdin.isTTY === true);
console.log("compared", process.stdout?.isTTY === true, process.stderr?.columns === undefined);
console.log("defaulted", process.stdin?.isTTY ?? "no terminal", process.stdout?.columns ?? 80);
console.log("negated", !!process.stdin?.isTTY, !process.stdout?.isTTY, !!process.stderr?.rows);
if (process.stdin?.isTTY) {
  console.log("stdin is a terminal");
} else {
  console.log("stdin is no terminal");
}
if (process.stdout?.columns) console.log("stdout has columns");
console.log("passed on", wants(process.stdin?.isTTY), wants(process.stderr?.isTTY));

const stored = process.stdin?.isTTY;
const width = process.stdout?.columns;
show("stored", stored);
show("width", width);

const source = process.stdin;
const sink = process.stderr;
show("alias.isTTY", source.isTTY);
show("alias?.isTTY", source?.isTTY);
show("alias?.fd", source?.fd);
console.log("alias", source.isTTY === true, source?.isTTY ?? "no terminal", !!source.isTTY);
console.log("alias passed on", wants(source.isTTY), wants(source?.isTTY));
const { isTTY: sourceIsTTY, fd: sourceFd } = source;
show("pattern isTTY", sourceIsTTY);
show("pattern fd", sourceFd);
show("sink?.isTTY", sink?.isTTY);
show("sink?.columns", sink?.columns);
show("sink?.fd", sink?.fd);

show("pick(out)?.isTTY", pick("out")?.isTTY);
show("pick(err)?.fd", pick("err")?.fd);
show("pick(none)?.fd", pick("none")?.fd);
show("pick(none)?.rows", pick("none")?.rows);
console.log("picked", pick("err")?.columns ?? 80, pick("none")?.isTTY ?? "no stream");
show("input(true)?.isTTY", input(true)?.isTTY);
show("input(false)?.isTTY", input(false)?.isTTY);
show("input(true)?.fd", input(true)?.fd);

// A plain object with optional members takes the ordinary road.
interface Term {
  isTTY?: boolean;
  columns?: number;
}
const terms: (Term | undefined)[] = [{}, { isTTY: true, columns: 80 }, { isTTY: false }, undefined];
for (const term of terms) {
  console.log("term", term?.isTTY === true, String(term?.isTTY), term?.columns ?? "none", !!term?.isTTY);
}
