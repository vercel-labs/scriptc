// A Console built with inspectOptions or colorMode formats every method
// that Node formats with util.formatWithOptions over the instance options:
// util.format (log, info, debug, warn, error, dirxml), console.dir,
// console.trace's heading, console.assert's message and console.group's
// label. colorMode true forces ANSI colors, false (and 'auto' over a
// stream that is not a terminal) leaves them out, and
// colorMode beside inspectOptions.colors is Node's incompatible pair.
import { Console } from "node:console";
import { Writable } from "node:stream";

interface Sink { out: string }
interface Streams { sink: Sink; stream: Writable }

function streamOf(): Streams {
  const sink: Sink = { out: "" };
  const stream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      sink.out += String(chunk);
      cb();
    },
  });
  return { sink, stream };
}
function attempt(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "ok");
  } catch (error) {
    const e = error as { code?: string; message?: string };
    console.log(label, "threw", e.code, e.message);
  }
}
attempt("bad mode", () => { const s = streamOf(); new Console({ stdout: s.stream, colorMode: "yes" }); });
attempt("mode 1", () => { const s = streamOf(); new Console({ stdout: s.stream, colorMode: 1 }); });
attempt("bad options", () => { const s = streamOf(); new Console({ stdout: s.stream, inspectOptions: 5 }); });
attempt("pair", () => { const s = streamOf(); new Console({ stdout: s.stream, colorMode: true, inspectOptions: { colors: true } }); });
attempt("null mode", () => { const s = streamOf(); new Console({ stdout: s.stream, colorMode: null }); });
const cs = streamOf();
const colored = new Console({ stdout: cs.stream, stderr: cs.stream, colorMode: true });
colored.log({ a: 1, s: "x" });
colored.info("plain");
colored.warn({ a: 1 });
colored.dir({ a: { b: 1 } });
colored.dirxml({ a: 1 });
colored.assert(false, "m %d", 2);
colored.assert(false, { a: 1 });
colored.group({ a: 1 }); colored.log("in"); colored.groupCollapsed("c"); colored.log("deep"); colored.groupEnd(); colored.groupEnd();
colored.trace({ a: 1 });
console.log("colored output", JSON.stringify(cs.sink.out.split("\n").filter((l) => !l.trim().startsWith("at ")).join("\n")));
const ds = streamOf();
const depth = new Console({ stdout: ds.stream, inspectOptions: { depth: 0, maxArrayLength: 2, compact: false, breakLength: 30 } });
depth.log({ a: { b: 1 }, arr: [1, 2, 3] });
depth.dir({ a: { b: 1 } });
console.log("depth output", JSON.stringify(ds.sink.out));

const auto = streamOf();
const automatic = new Console({ stdout: auto.stream, colorMode: "auto" });
automatic.log({ a: 1 });
console.log("auto output", JSON.stringify(auto.sink.out));

// A Console-typed global console receiver prints like the global console,
// even when the program also builds an option-bearing instance.
const globalAlias = console;
globalAlias.log("via the global alias");

// A method lowered before any option-bearing constructor still formats with
// the instance's options when it runs.
function report(target: Console): void {
  target.log({ a: 1 });
}
const early = streamOf();
const earlyConsole = new Console({ stdout: early.stream, stderr: early.stream, colorMode: true });
report(earlyConsole);
console.log("early output", JSON.stringify(early.sink.out));

// colorMode 'auto' follows Node's shouldColorize: FORCE_COLOR decides on
// its own, so a stream that is not a terminal colors when it is set.
process.env.FORCE_COLOR = "1";
const forced = streamOf();
new Console({ stdout: forced.stream, colorMode: "auto" }).log({ a: 1 });
delete process.env.FORCE_COLOR;
console.log("forced output", JSON.stringify(forced.sink.out));
process.env.FORCE_COLOR = "0";
const disabled = streamOf();
new Console({ stdout: disabled.stream, colorMode: "auto" }).log({ a: 1 });
delete process.env.FORCE_COLOR;
console.log("disabled output", JSON.stringify(disabled.sink.out));

// The options can be spelled as shorthand properties: the constructor
// reads them, and the methods format with the instance's options.
const shorthandOptions = { depth: 0 };
const shorthand = streamOf();
const shorthandConsole = new Console({ stdout: shorthand.stream, inspectOptions: shorthandOptions });
shorthandConsole.log({ a: { b: 1 } });
console.log("shorthand output", JSON.stringify(shorthand.sink.out));
const shorthandMode = true;
const shorthandColor = streamOf();
const shorthandColored = new Console({ stdout: shorthandColor.stream, colorMode: shorthandMode });
shorthandColored.log({ a: 1 });
console.log("shorthand color output", JSON.stringify(shorthandColor.sink.out));

// A stored output method is the same method: it formats with the instance's
// inspectOptions and colorMode, so detaching one changes nothing.
const storedSink = streamOf();
const storedConsole = new Console({
  stdout: storedSink.stream,
  inspectOptions: { depth: 0 },
  colorMode: true,
});
storedConsole.log({ a: { b: 1 }, s: "x" });
const directOutput = storedSink.sink.out;
const storedLog = storedConsole.log;
storedLog({ a: { b: 1 }, s: "x" });
const storedOutput = storedSink.sink.out.slice(directOutput.length);
console.log("stored output", JSON.stringify(storedOutput), storedOutput === directOutput);

// The global console's stored methods read its own colorMode ('auto') too.
process.env.FORCE_COLOR = "1";
const globalLog = console.log;
globalLog({ a: 1 });
delete process.env.FORCE_COLOR;
