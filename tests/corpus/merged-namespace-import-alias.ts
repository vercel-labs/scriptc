// @transform-types
// `import x = N.member` where the namespace merges with a class or an enum:
// a copy of the member taken where the alias stands, as for a namespace
// that merges with nothing.
class Box {
  constructor(public v: number) {}
}
namespace Box {
  export let made = 0;
  export const limit = 3;
  export function make(v: number): Box {
    made++;
    return new Box(v);
  }
}
import made0 = Box.made;
import limit = Box.limit;
import make = Box.make;
console.log(made0, limit, make(7).v, Box.made, made0);
Box.made = 10;
console.log(made0, Box.made, make(8).v, Box.made, typeof make);
import made1 = Box.made;
console.log(made0, made1);

enum Level {
  Low,
  High,
}
namespace Level {
  export let seen = 0;
  export const top = 9;
  export function parse(s: string): Level {
    seen++;
    return s === "high" ? Level.High : Level.Low;
  }
}
import seen0 = Level.seen;
import top = Level.top;
import parse = Level.parse;
console.log(seen0, top, parse("high"), Level.seen, seen0);
Level.seen = 5;
console.log(seen0, Level.seen, parse("low"), Level.seen, typeof parse);
import seen1 = Level.seen;
console.log(seen0, seen1);

function later(): string {
  return [made0, made1, seen0, seen1, limit, top, make(1).v, parse("high")].join(" ");
}
console.log(later(), Box.made, Level.seen);
