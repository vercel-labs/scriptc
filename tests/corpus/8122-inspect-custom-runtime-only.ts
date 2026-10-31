// Classes whose [util.inspect.custom] method runs only from the runtime
// inspect walk (instances held as unknown or in parsed JSON) compile with
// the functions and methods that method calls.
import * as util from "node:util";
function helper(n: number): string {
  return "H" + n;
}
class Base {
  [util.inspect.custom](): string {
    return helper(1) + this.tag();
  }
  tag(): string {
    return "-base";
  }
}
class Derived extends Base {
  tag(): string {
    return "-derived";
  }
}
class Box<T> {
  item: T;
  constructor(item: T) {
    this.item = item;
  }
  [util.inspect.custom](): string {
    return "Box(" + helper(2) + ")";
  }
}
const xs: unknown[] = [new Derived(), new Box<number>(3)];
console.log(xs);
const j = JSON.parse('{"a":1}');
j.d = new Derived();
console.log(j);
