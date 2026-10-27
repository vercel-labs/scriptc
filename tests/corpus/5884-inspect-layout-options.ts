// util.inspect and console.dir with the breakLength and compact options:
// breakLength (a number or Infinity) is the line width the single-line
// form and the array grid must fit, and compact sets how many inner
// levels may join one line and the grid's column limit (compact * 4).
// compact: false (or a number below 1) puts every entry of every
// composite on its own line. A render with these options leaves later
// renders at the defaults.
import { inspect } from "node:util";

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

const config = {
  name: "service",
  ports: [80, 443],
  limits: { cpu: 2, memory: { soft: "1G", hard: "2G" } },
  tags: new Set(["a", "b"]),
  routes: new Map([["/", { handler: "index", methods: ["GET", "HEAD"] }]]),
};
const numbers = Array.from({ length: 30 }, (_, i) => i * 37);
const words = Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i).repeat((i % 5) + 1));
const points = Array.from({ length: 8 }, (_, i) => new Point(i, i * i));
const text = { text: "line one\nline two\nline three is a longer one" };

console.log(inspect(config, { compact: false }));
console.log(inspect(config, { compact: 1 }));
console.log(inspect(config, { compact: 5, depth: Infinity }));
console.log(inspect(config, { breakLength: 40 }));
console.log(inspect(config, { breakLength: Infinity }));
console.log(inspect(config, { breakLength: 120, compact: 2 }));
console.log(inspect(numbers, { compact: false }));
console.log(inspect(numbers, { compact: 1 }));
console.log(inspect(numbers, { breakLength: 40 }), inspect(numbers, { breakLength: 150 }));
console.log(inspect(words, { compact: 6 }), inspect(words, { breakLength: 60 }));
console.log(inspect(points, { compact: 2, breakLength: 120 }));
console.log(inspect(points, { compact: false }));
console.log(inspect(text, { breakLength: Infinity }), inspect(text, { compact: false }));
console.log(inspect(text.text, { breakLength: 20 }));
console.log(inspect([], { compact: false }), inspect({}, { compact: false }), inspect(new Map([[1, 2]]), { compact: false }));
console.log(inspect({ a: 1 }, { compact: 0 }), inspect({ a: [1, 2] }, { breakLength: 0 }));
const parsed: unknown = JSON.parse('{"x":[1,2,{"y":"z"}],"w":{"v":null}}');
console.log(inspect(parsed, { compact: false }), inspect(parsed, { breakLength: 10 }));
console.dir(config, { compact: false, depth: 0 });
console.dir(parsed, { breakLength: 20 });
console.log(config);
