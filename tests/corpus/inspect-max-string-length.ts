// util.inspect with maxStringLength truncates string values to the given
// number of code units and reports the rest in a trailer, at every depth and
// inside collections, while keys and numbers stay whole; null and Infinity
// show every character. The option reads at run time from an options object,
// reaches util.formatWithOptions' %o and %O but not %s, console.dir, and the
// options a custom inspect function receives. Truncation composes with
// breakLength's line splitting, and a cut between a surrogate pair renders
// the lone surrogate escaped.
import * as util from "node:util";

const long = "abcdefghijklmnopqrstuvwxyz";
const show = (value: unknown, options: util.InspectOptions): void =>
  console.log(util.inspect(value, options));

show(long, { maxStringLength: 5 });
show(long, { maxStringLength: 0 });
show(long, { maxStringLength: 1 });
show(long, { maxStringLength: 26 });
show(long, { maxStringLength: 27 });
show(["abcdefghij", "abcdefghij"], { maxStringLength: 4 });
show({ a: "abcdefghij", abcdefghij: 1 }, { maxStringLength: 4 });
show(["abcdefghij"], { maxStringLength: 4, depth: 0 });
show({ k: ["abcdefghij"] }, { maxStringLength: 4, depth: 1 });
show(new Map([["abcdefghij", "klmnopqrst"]]), { maxStringLength: 4 });
show(new Set(["abcdefghij"]), { maxStringLength: 4 });
show("abcdefghij", { maxStringLength: null });
show("abcdefghij", { maxStringLength: Infinity });
show("abcdefghij", { maxStringLength: 4, sorted: true });
show("abcdefghij", { maxStringLength: 4, depth: null });

const runtime: util.InspectOptions = { maxStringLength: 4 };
show("abcdefghij", runtime);
show("abcdefghij", { ...runtime, depth: 1 });
show("abcdefghij", { maxStringLength: (long.length as number) - 20 });
const unbounded: util.InspectOptions = { maxStringLength: Infinity };
show("abcdefghij", unbounded);
const nothing: util.InspectOptions = { maxStringLength: 0 };
show("abcdefghij", nothing);

console.log(util.formatWithOptions({ maxStringLength: 4 }, "%o", "abcdefghij"));
console.log(util.formatWithOptions({ maxStringLength: 4 }, "%O", ["abcdefghij"]));
console.log(util.formatWithOptions({ maxStringLength: 4 }, "%s", "abcdefghij"));
console.dir("abcdefghij", { maxStringLength: 4 });
console.dir(["abcdefghij"], { maxStringLength: 4 });

show("line one\nline two\nline three", { maxStringLength: 40, breakLength: 20 });
show("line one\nline two\nline three", { maxStringLength: 12 });
show("😀😀😀", { maxStringLength: 1 });
show("ab😀cd", { maxStringLength: 3 });
show(["abcdefghijklmnopqrstuvwxyz"], { maxStringLength: 10, breakLength: 20 });
show(["abcdefghij"], { maxStringLength: 4, compact: 1 });

class Custom {
  [util.inspect.custom](_depth: number, options: util.InspectOptions): string {
    return `custom(${options.maxStringLength})`;
  }
}
console.log(util.inspect(new Custom(), { maxStringLength: 4 }));
console.log(util.inspect("short"));
