// A builtin handle (a process stream) where a record type names some of its
// members stays the handle as the argument of a directly called function
// declaration and in a const. Every other slot of the record type would
// hold a copy of the members, which stops following the stream.
type TermStream = { isTTY?: boolean };

// A record field, an array element, a returned value and a `let`.
const options: { stream: TermStream; label: string } = { stream: process.stderr, label: "a" };
console.log(options.label);
const all: TermStream[] = [process.stdout];
console.log(all.length);
function pick(): TermStream {
  return process.stdout;
}
console.log(pick());
let current: TermStream = process.stdout;
current = {};
console.log(current);

// A method parameter and an arrow function's parameter.
class Theme {
  of(stream: TermStream): boolean {
    return stream === process.stderr;
  }
}
console.log(new Theme().of(process.stderr));
const arrow = (stream: TermStream): boolean => stream === process.stderr;
console.log(arrow(process.stderr));

// A parameter that defaults to a stream: only a direct call that omits the
// argument, or passes the stream, delivers it. An argument that may be
// undefined would leave the default to the function itself.
function theme(stream: TermStream = process.stdout): boolean {
  return stream === process.stderr;
}
function forward(stream?: TermStream): boolean {
  return theme(stream);
}
console.log(forward(), theme(undefined));

// A const that keeps the stream is the stream: listing it is the stream's
// own refusal.
const sink: { write(text: string): boolean } = process.stdout;
console.log(Object.keys(sink).length);

// `process.stdin` is read as an untyped value: the checked conversion into
// a record type admits plain objects only and would throw when it runs.
let input: { isRaw?: boolean } = process.stdin;
input = {};
console.log(input);
