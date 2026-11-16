// node:console Console instances lower their whole member surface: the
// output members through util.format, and count, countReset, time,
// timeLog, timeEnd, group, groupCollapsed, groupEnd, assert, dir, dirxml,
// table, trace and clear over the instance's own state and its own
// streams. Grouped lines are indented where Node indents them, including
// after a message's own trailing newline and on an empty line. Node's
// elapsed times and captured frames are not reproducible run to run, so
// this program pins the shapes they answer instead (trace's frame block is
// scriptc's own text, SEMANTICS divergence 11).
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

/** The chunk with its elapsed time and trace frame block replaced by
 * stable text. */
function stable(chunks: string[]): string {
  return chunks
    .map((chunk) => {
      const text = chunk
        .replace(/\d+(\.\d+)?(ms|s)/g, "<t>")
        .replace(/\(node:\d+\)/g, "(node:<pid>)");
      return text.startsWith("Trace") ? text.slice(0, text.indexOf("\n") + 1) : text;
    })
    .join("|");
}

const out = collector();
const err = collector();
const c = new Console({ stdout: out.stream, stderr: err.stream });

c.log("plain");
c.info("info %s", "one");
c.debug("debug %d %o", 2, { k: [1] });
c.warn("warn %j", { a: 1 });
c.error("error %i", 3.9);
c.dirxml("dirxml", 1);

c.count();
c.count("x");
c.count("x");
c.count("x");
c.countReset("x");
c.count("x");

c.time("t");
c.timeLog("t", "mid", { a: 1 });
c.timeEnd("t");

c.group("group label");
c.log("indented\nsecond line");
c.log("trailing newline\n");
c.log("");
c.log("multi\n\nblank");
c.group();
c.groupCollapsed("collapsed");
c.log("deep");
c.groupEnd();
c.groupEnd();
c.groupEnd();
c.log("back");

const stdio = new Console({ stdout: process.stdout });
stdio.group("stdio");
stdio.log("ends here\n");
stdio.groupEnd();

c.assert(true, "not printed");
c.assert(false, "asserted");
c.assert(false, "asserted %s", "format");

c.dir({ deep: { x: 1 } });
c.dir({ deep: { x: 1 } }, { depth: 0 });
c.dir([1, [2, [3]]]);

c.table([{ a: 1, b: 2 }, { a: 3 }]);
c.table({ x: 1, y: "two" });

c.trace("traced");
c.clear();

console.log("stdout:", stable(out.chunks));
console.log("stderr:", stable(err.chunks));
