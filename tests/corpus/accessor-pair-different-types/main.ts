// A getter and setter pair whose halves declare different types (tsc 5.1+):
// a write converts into the setter's parameter type and a read answers the
// getter's, through typed code, untyped JavaScript, an interface view, an
// untyped value, destructuring and a static pair, as in Node.
import { setData, readData } from "./untyped.js";
class Text {
  private v = "";
  get data(): string { return this.v; }
  set data(value: string | number | null) { this.v = value === null ? "" : String(value); }
}
const t = new Text();
t.data = 5;
console.log(t.data, typeof t.data, t.data.length);
t.data = "abc";
t.data += "d";
console.log(t.data);
t.data = null;
console.log(JSON.stringify(t.data));
setData(t, 42);
console.log(t.data, readData(t));
interface HasData { data: string }
const view: HasData = t;
view.data = "via-view";
console.log(view.data, t.data);
const anyT: any = t;
anyT.data = 7;
console.log(anyT.data, typeof anyT.data);
class Comment extends Text {}
const c = new Comment();
c.data = 9;
console.log(c.data);

// The setter takes a wider type than the getter answers.
class Counter {
  private n = 0;
  get value(): number { return this.n; }
  set value(v: number | string) { this.n = typeof v === "string" ? Number(v) : v; }
  static #mode = "a";
  static get mode(): string { return Counter.#mode; }
  static set mode(m: string | boolean) { Counter.#mode = String(m); }
}
const counter = new Counter();
counter.value = "41";
counter.value++;
console.log(counter.value);
counter["value"] = "7";
console.log(counter.value, counter["value"]);
({ v: counter.value } = { v: "3" });
console.log(counter.value);
Counter.mode = true;
console.log(Counter.mode);
class Unrelated {
  get x(): number { return 1; }
  set x(v: string) { console.log("set", v); }
}
const u = new Unrelated();
u.x = "s";
console.log(u.x);
[counter.value] = ["8"];
console.log(counter.value);
for ([counter.value] of [["2"], ["3"]]) console.log(counter.value + 1);

class Box {
  v = "";
  get data(): string {
    return this.v;
  }
  set data(value: string | number) {
    this.v = String(value);
  }
}
const b = new Box();
b.data = 5;
console.log(b.data);
