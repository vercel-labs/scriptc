// @transform-types
// `import x = fn.member` on a function+namespace merge is Node's
// `const x = fn.member`: a copy of the function object's property, taken
// where the alias stands. The property can be replaced afterwards whatever
// the member's declaration says, and the alias keeps what it copied.
function gauge(n: number): string {
  return n.toFixed(gauge.digits) + gauge.unit;
}
namespace gauge {
  export let unit = "m";
  export let level = 1;
  export var slack = 0.5;
  export const digits = 1;
  export let marks: number[] = [1];
  export function twice(n: number): number {
    return n * 2;
  }
  export function thrice(n: number): number {
    return n * 3;
  }
  export function bump(): number {
    gauge.level += 10;
    return gauge.level;
  }
}

// A property replaced before the alias statement: the alias copies the
// replacement, not the declaration.
Object.assign(gauge, { thrice: (n: number): number => n * 300 });

import unit = gauge.unit;
import level = gauge.level;
import slack = gauge.slack;
import digits = gauge.digits;
import marks = gauge.marks;
import twice = gauge.twice;
import thrice = gauge.thrice;
import bump = gauge.bump;
console.log(unit, level, slack, digits, marks.join(","), gauge(2));
console.log(twice(2), thrice(2), gauge.twice(2), gauge.thrice(2), typeof twice, typeof unit);

// Every write form of the members after the aliases took their copies.
gauge.unit = "km";
gauge.level++;
gauge.level += 2;
gauge.level *= 3;
gauge.slack = 0.25;
Object.assign(gauge, { digits: 3, twice: (n: number): number => n * 200 });
console.log(unit, level, slack, digits, gauge.unit, gauge.level, gauge.slack, gauge.digits);
console.log(twice(2), thrice(2), gauge.twice(2), gauge.thrice(2), gauge(2));
console.log(bump(), level, gauge.level);

// The alias of an object member is the same object until the member is
// replaced.
gauge.marks.push(2);
console.log(marks.join(","), marks === gauge.marks);
gauge.marks = [9];
console.log(marks.join(","), gauge.marks.join(","), marks === gauge.marks);
[gauge.level, gauge.unit] = [100, "cm"];
console.log(level, unit, gauge.level, gauge.unit);

// The aliases as values, and in a function declared below them.
const held: (n: number) => number = twice;
function later(): string {
  return unit + ":" + level + ":" + twice(3) + ":" + [1, 2].map(thrice).join(",");
}
console.log(held(5), later());

// A second alias of the same member copies the property as it is now.
import unitNow = gauge.unit;
import twiceNow = gauge.twice;
console.log(unit, unitNow, twice(1), twiceNow(1));

// An alias of the merged function is the function object itself: a write
// through it is a write to the one object.
import g = gauge;
import gUnit = g.unit;
import gTwice = g.twice;
console.log(g(1), g.unit, gUnit, gTwice(4), g.twice(4), Object.keys(g).join(","));
g.unit = "ft";
console.log(g(1), gauge.unit, gUnit, unitNow, typeof g);

// Aliases declared inside another namespace, plain and exported.
namespace panel {
  import u = gauge.unit;
  import t = gauge.thrice;
  export import d = gauge.digits;
  export const seen = u + t(2) + d;
  export function show(): string {
    return u + "/" + t(3) + "/" + d;
  }
}
console.log(panel.seen, panel.show(), panel.d);
gauge.unit = "in";
Object.assign(gauge, { digits: 0, thrice: (n: number): number => n * 3000 });
console.log(panel.seen, panel.show(), panel.d, gauge(1), gauge.thrice(1));
