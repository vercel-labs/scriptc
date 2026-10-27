// TypeScript records and class instances read their inherited
// Object.prototype members as values, so the identity tests agree with
// Node: `o.constructor === Object`, `o.valueOf === Object.prototype.valueOf`.
interface Shape {
  kind: string;
  size: number;
}
class Box {
  width = 2;
  describe(): string {
    return `box ${this.width}`;
  }
}
const record: Shape = { kind: "square", size: 3 };
const box = new Box();
const empty = {};
console.log(record.constructor === Object, record.valueOf === Object.prototype.valueOf, record.toString === Object.prototype.toString);
console.log(record.hasOwnProperty === Object.prototype.hasOwnProperty, empty.valueOf === Object.prototype.valueOf, typeof record.constructor);
console.log(box.valueOf === Object.prototype.valueOf, box.toString === Object.prototype.toString, box.describe());
const parsed: unknown = JSON.parse('{"a":1}');
if (typeof parsed === "object" && parsed !== null) {
  console.log(parsed.constructor === Object, Object.getPrototypeOf(parsed) === Object.prototype);
}
console.log(Object.getPrototypeOf(record) === Object.prototype, record.toString(), record.constructor === empty.constructor);
