// @normalize-pid
// The documented timer handle surface: arguments reach the callback,
// unref/ref/hasRef track loop liveness, refresh and close chain, the primitive
// id is the handle's number, and the clear functions take either spelling and
// tolerate a dead handle. Every timer that fires shares the same 5 ms delay, so
// a later-created timer always expires later: Node's timers of one duration
// run in creation order however long the machine holds the process up. The
// interval is created last, and its second tick prints the story: an interval
// re-arms only after the callbacks before it ran, so nothing is still pending
// there. The delay warnings are pinned in timers-delay-warnings.ts.
const story: string[] = [];
const record = (line: string): void => {
  story.push(line);
};

const neg = setTimeout(() => record("negative fired"), 5);
const nan = setTimeout(() => record("nan fired"), 5);
const big = setTimeout(() => record("big fired"), 5);
const inf = setTimeout(() => record("inf fired"), 5);
console.log("delay handles", neg.hasRef(), nan.hasRef(), big.hasRef(), inf.hasRef());
for (const h of [neg, nan, big, inf]) h.unref();

const args = setTimeout(
  (a: string, b: number, c: { v: string }) => record(`args ${a} ${b} ${c.v}`),
  5,
  "one",
  2,
  { v: "three" },
);
console.log("unref chain", args.unref() === args, args.hasRef());
console.log("ref chain", args.ref() === args, args.hasRef());

const refreshed = setTimeout(() => record("refreshed fired"), 5);
const back = refreshed.refresh();
console.log("refresh chain", back === refreshed, typeof back);

const closed = setTimeout(() => record("closed fired"), 5);
console.log("close chain", closed.close() === closed, closed.close() === closed);

const disposed = setTimeout(() => record("disposed timeout fired"), 5);
disposed[Symbol.dispose]();
disposed[Symbol.dispose]();

const numeric = setTimeout(() => record("numeric cleared"), 5);
clearTimeout(Number(numeric));
const ivNumeric = setInterval(() => record("interval numeric cleared"), 5);
clearInterval(Number(ivNumeric));
const nullCleared = setTimeout(() => record("null cleared"), 5);
clearTimeout(null);

const im = setImmediate((x: number) => console.log("immediate", x), 9);
console.log(
  "immediate ref",
  im.hasRef(),
  im.unref() === im,
  im.hasRef(),
  im.ref() === im,
  im.hasRef(),
);
const imDisposed = setImmediate(() => record("disposed immediate fired"));
imDisposed[Symbol.dispose]();
const imCleared = setImmediate(() => record("cleared immediate fired"));
clearImmediate(imCleared);

let ticks = 0;
const interval = setInterval(
  (label: string) => {
    ticks++;
    record(`interval ${label} ${ticks}`);
    if (ticks === 2) {
      interval.close();
      console.log(story.join("\n"));
      console.log("interval ticks", ticks);
    }
  },
  5,
  "tick",
);
console.log("primitive", String(interval).length > 0);
