// Members of a class that extends Array, reached through an element of an
// array of its instances (`live[i].refresh()`), and a JavaScript subclass
// whose methods write the inherited `length`.
import { Listy } from "./listy.js";

class Rows extends Array<number> {
  tag = "rows";
  refresh(): void {
    this.length = 0;
  }
  total(): number {
    let sum = 0;
    for (const n of this) sum += n;
    return sum;
  }
}

const live: Rows[] = [new Rows(), new Rows()];
live[0].push(1, 2, 3);
live[1].push(4);
console.log(live[0].total(), live[1].total(), live[0].length);
for (let i = 0; i < live.length; i++) live[i].refresh();
console.log(live[0].length, live[1].length, live[0].total());
live[1].tag = "renamed";
console.log(live[0].tag, live[1].tag);

try {
  live[5].refresh();
} catch (e) {
  console.log(String(e));
}
try {
  console.log(live[5].tag);
} catch (e) {
  console.log(String(e));
}
try {
  live[5].tag = "x";
} catch (e) {
  console.log(String(e));
}

const one = new Listy();
one.push("a", "b", "c");
console.log(one.truncate(1), one.length, one[0]);
one.refresh();
console.log(one.length, one instanceof Listy, Array.isArray(one));
