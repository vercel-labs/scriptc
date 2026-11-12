// @normalize-pid
// node:console Console instances keep their own counters, timers and group
// indentation: a counter or timer of one instance is invisible to another
// instance and to the global console, and each instance indents grouped
// output by its own groupIndentation. The prototype's remaining members
// (count, countReset, time, timeEnd, timeLog, group, groupCollapsed,
// groupEnd, dir, dirxml, table, assert, clear) write to the instance's own
// streams with Node's formatting, option rules, and warnings.
import { Console } from "node:console";
import { Writable } from "node:stream";

function collector(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, chunks };
}

/** The collected text with timer durations replaced: elapsed times are the
 * one part of the output the oracle cannot pin. */
function text(chunks: string[]): string {
  return chunks.splice(0).join("").replace(/: \d+(\.\d+)?ms/g, ": <ms>");
}

process.on("warning", (warning) => {
  console.log(`warning: ${warning.name}: ${warning.message}`);
});

const a = collector();
const b = collector();
const one = new Console({ stdout: a.stream, stderr: a.stream });
const two = new Console({ stdout: b.stream, stderr: b.stream });

// Counters belong to the instance: the default and named counters of one
// instance never see another's, nor the global console's.
one.count();
one.count();
two.count();
one.count("named");
one.countReset();
one.count();
two.countReset("named");
one.countReset("named");
one.count("named");
console.count("named");
console.countReset("named");
console.log("counters", JSON.stringify(text(a.chunks)), JSON.stringify(text(b.chunks)));

// Timers too, including timeLog's data arguments and the warnings for a
// label this instance does not have.
one.time("task");
one.timeLog("task", "step", 1);
one.timeEnd("task");
one.timeEnd("task");
one.timeLog("absent", "evaluated");
two.time("task");
two.timeEnd("task");
console.log("timers", JSON.stringify(text(a.chunks)), JSON.stringify(text(b.chunks)));

// Group indentation is per instance and comes from groupIndentation.
const zero = collector();
const three = collector();
const four = collector();
const flat = new Console({ stdout: zero.stream, groupIndentation: 0 });
const spaced = new Console({ stdout: three.stream, groupIndentation: 3 });
const wide = new Console({ stdout: four.stream, groupIndentation: 4 });
flat.group("flat");
flat.log("one\ntwo");
flat.groupCollapsed();
flat.log("nested");
flat.groupEnd();
flat.log("back");
flat.groupEnd();
flat.log("out");
spaced.group();
spaced.log("three");
spaced.groupEnd();
wide.group();
wide.group();
wide.log("four");
wide.groupEnd();
wide.groupEnd();
wide.log("after");
console.log("indent", JSON.stringify(text(zero.chunks)), JSON.stringify(text(three.chunks)));
console.log("indent", JSON.stringify(text(four.chunks)));

// The rest of the prototype: dir with options, dirxml, table over object
// rows with a properties list and over primitive rows, assert with a
// format string, and clear on a stream that is not a TTY.
const rest = collector();
const c = new Console({ stdout: rest.stream, stderr: rest.stream });
c.dir({ outer: { inner: { deep: 1 } } }, { depth: 1 });
c.dirxml({ x: 1 }, [2, 3]);
c.table(
  [
    { p: 1, q: 2 },
    { p: 3, q: 4 },
  ],
  ["q"],
);
c.table(["s", 7]);
c.assert(true, "never printed");
c.assert(false, "failed %d of %s", 2, "three");
c.assert(false);
c.clear();
console.log("rest", JSON.stringify(text(rest.chunks)));

// Reached through a Console-typed parameter and a closure: the same
// instance state follows the value.
function grouped(logger: Console, label: string): void {
  logger.group(label);
  logger.count("through");
  logger.groupEnd();
}
const later = (): void => grouped(one, "closure");
grouped(one, "param");
later();
console.log("carried", JSON.stringify(text(a.chunks)));
