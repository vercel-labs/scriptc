// A package's .d.ts declares generic classes its JavaScript implements:
// the program names them with type arguments.
import { BehaviorSubject, Box, Subject } from "subjectkit";

const numbers = new Subject<number>();
let total = 0;
const stop = numbers.subscribe((n) => {
  total += n;
  console.log("number", n.toFixed(1));
});
numbers.next(1);
numbers.next(2.5);
console.log("observed", numbers.observed);
stop();
numbers.next(100);
console.log("total", total, "observed", numbers.observed);

const labels: Subject<string> = new Subject<string>();
labels.subscribe((s) => console.log("label", s.toUpperCase(), s.length));
labels.next("a");
labels.next("bc");

const state = new BehaviorSubject<string>("idle");
state.subscribe((s) => console.log("state", s));
state.next("busy");
console.log("current", state.getValue());

const box = new Box<number, "count">(3, "count");
console.log(box.describe(), box.value + 1, box.tag);
const plain: Box<string> = new Box("x", "letter");
console.log(plain.describe());
