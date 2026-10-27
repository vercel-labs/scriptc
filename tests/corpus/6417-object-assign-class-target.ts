// Object.assign with a class instance as the target and a plain record as
// the source: the record's fields land on the instance's own fields (also
// readonly ones, which only the checker guards), optional source fields
// only when present, and the call answers the instance itself.
class Settings {
  retries = 1;
  readonly name: string = "default";
  verbose = false;
  label?: string;
  describe(): string {
    return `${this.name}:${this.retries}:${this.verbose}:${this.label ?? "-"}`;
  }
}

const s = new Settings();
const same = Object.assign(s, { retries: 3, verbose: true });
console.log(same === s, s.describe());

function patch(target: Settings, update: { label?: string }): Settings {
  return Object.assign(target, update);
}
console.log(patch(s, { label: "x" }).describe());
console.log(patch(s, {}).describe());
console.log(patch(s, { label: undefined }).describe(), Object.assign(s, { retries: 0 }).describe());

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}
const p = new Point(1, 2);
Object.assign(p, { y: 5 });
console.log(p.x, p.y, JSON.stringify(p), p instanceof Point);
