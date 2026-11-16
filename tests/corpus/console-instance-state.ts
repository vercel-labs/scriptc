// Console instances keep their own counters, timers and group indentation:
// a group opened on one instance never indents another's lines (or the
// global console's), counters and timers with the same label are separate
// per instance, and timeEnd on one instance leaves another's timer alone.
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

function stable(chunks: string[]): string {
  return chunks.join("|").replace(/\d+(\.\d+)?(ms|s)/g, "<t>");
}

const first = collector();
const second = collector();
const a = new Console({ stdout: first.stream });
const b = new Console({ stdout: second.stream });

a.count("shared");
a.count("shared");
b.count("shared");
b.count();
console.log("counters:", stable(first.chunks), "/", stable(second.chunks));

a.time("timer");
b.time("timer");
a.timeEnd("timer");
b.timeLog("timer");
console.log("timers:", stable(first.chunks), "/", stable(second.chunks));

a.group("A");
a.log("a one");
b.log("b one");
a.group();
a.log("a two");
b.group("B");
b.log("b two");
console.group();
console.log("global one");
console.groupEnd();
a.groupEnd();
a.groupEnd();
a.groupEnd();
a.log("a three");
b.groupEnd();
b.groupEnd();
b.log("b three");
console.log("after:", stable(first.chunks));
console.log("second:", stable(second.chunks));
