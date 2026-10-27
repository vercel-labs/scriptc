// util.inspect, console.log, console.dir and util.format's %s, %O and %o
// print a Date as Node does: its toISOString() at every depth (including
// six-digit signed years), and "Invalid Date" for a NaN time value. Dates
// in record fields and class instances follow the usual layout.
import { format, inspect } from "node:util";

const epoch = new Date(0);
console.log(epoch);
console.log(inspect(epoch), inspect(epoch, { depth: 0 }), inspect(new Date("garbage")));
console.log(inspect({ a: { b: { c: { epoch } } } }), inspect({ a: { b: { epoch } } }));
console.log(format("%s|%O|%o", epoch, epoch, { epoch }));
console.log("at %s", new Date(1e12));
console.log({
  epoch,
  invalid: new Date(Number.NaN),
  latest: new Date(8.64e15),
  earliest: new Date(-8.64e15),
});
console.log({
  leap: new Date(Date.UTC(2024, 1, 29, 12, 30, 45, 123)),
  negativeYear: new Date(Date.UTC(-1, 0, 1)),
  farFuture: new Date(Date.UTC(10000, 0, 1)),
  parsed: new Date("2020-06-15T08:09:10.011+02:00"),
});

class Entry {
  at = new Date(5);
  name = "entry";
}
console.log(new Entry(), [new Entry()]);
console.error(epoch);
console.dir({ epoch }, { depth: 0 });
