// 'resize' and 'error' listeners on a process stream held as a value (a
// parameter, a record field, a class field, an optional binding): the
// registration is made on the stream object, as it is when written on
// process.stdout itself. Nothing fires here (the streams are not terminals
// and no write fails); the program pins that every form registers, removes,
// answers the stream, and does not keep the process alive.
import type { WriteStream } from "node:tty";

function watch(panel: WriteStream, label: string): void {
  let seen = 0;
  const resized = () => {
    seen++;
    console.log(label, "resized", seen);
  };
  panel.on("resize", resized);
  console.log(label, "watching", seen);
  panel.removeListener("resize", resized);
  console.log(label, "released");
}
watch(process.stdout, "out");
watch(process.stderr, "err");

// once / off / addListener, and a listener that stays registered.
function arm(panel: WriteStream): void {
  const a = () => console.log("a");
  const b = () => console.log("b");
  const c = () => console.log("c");
  panel.once("resize", a);
  panel.addListener("resize", b);
  panel.off("resize", b);
  panel.on("resize", c);
  console.log("armed");
}
arm(process.stdout);
arm(process.stderr);

// 'error': the one-string writes around it keep their direct form.
function guard(panel: WriteStream, label: string): void {
  let failures = 0;
  const failed = (problem: Error) => {
    failures++;
    console.log(label, "failed", problem.message);
  };
  panel.on("error", failed);
  panel.write(label + " line one\n");
  panel.removeListener("error", failed);
  panel.write(label + " line two\n");
  console.log(label, "failures", failures);
}
guard(process.stdout, "out");
guard(process.stderr, "err");

// Listener values of every kind, and removal of one never added.
class Counter {
  count = 0;
  bump(): void {
    this.count++;
  }
}
function onResize(): void {
  console.log("declared listener");
}
function wire(panel: WriteStream): void {
  const counter = new Counter();
  const bound = counter.bump.bind(counter);
  const failed = function (problem: Error): void {
    console.log("expression listener", problem.message);
  };
  panel.on("resize", onResize);
  panel.on("resize", bound);
  panel.on("error", failed);
  panel.on("error", failed);
  panel.on("error", (problem: Error) => console.log("inline", problem.name));
  panel.removeListener("resize", onResize);
  panel.removeListener("resize", bound);
  panel.removeListener("error", failed);
  panel.removeListener("error", onResize);
  console.log("wired", counter.count);
}
wire(process.stdout);

// The call's value is the stream it was made on.
function chained(panel: WriteStream): void {
  const same = panel.on("error", () => {});
  console.log(same === panel, typeof same.columns);
  panel
    .on("resize", () => {})
    .on("error", () => {})
    .write("chained\n");
}
chained(process.stdout);

// A stream kept in a record field and in a class field.
interface Surface {
  panel: WriteStream;
  title: string;
}
class Board {
  private readonly panel: WriteStream;
  constructor(panel: WriteStream) {
    this.panel = panel;
  }
  draw(text: string): void {
    const resized = () => console.log("board resized");
    this.panel.on("resize", resized);
    this.panel.write(text);
    this.panel.removeListener("resize", resized);
  }
}
const surface: Surface = { panel: process.stdout, title: "main" };
surface.panel.on("error", () => console.log("surface failed"));
surface.panel.write(surface.title + "\n");
new Board(process.stderr).draw("board\n");

// Through an optional chain.
function maybe(panel: WriteStream | undefined, label: string): void {
  panel?.on("resize", () => console.log("resized"));
  console.log(label, panel === undefined);
}
maybe(process.stdout, "present");
maybe(undefined, "absent");

// The same forms written on the process streams themselves.
const directFailed = (problem: Error) => console.log("failed", problem.message);
process.stdout.on("error", directFailed);
process.stderr.once("error", directFailed);
process.stdout.removeListener("error", directFailed);
process.stderr.off("error", directFailed);

setTimeout(() => console.log("timer ran; no listener keeps the loop alive"), 5);
