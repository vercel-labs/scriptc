// A field holds a function that reads `arguments`; typed calls pass the
// argument once. The named parameter and `arguments[0]` are the same value,
// and the argument's side effects run once.
import { Recorder } from "./recorder.js";

let calls = 0;
function next(): number {
  calls++;
  return calls;
}

const recorder = new Recorder();
console.log(recorder.record(next()).join(","), calls);
console.log(recorder.record(next(), 7).join(","), calls);

// The same call through a record's field.
const holder = { record: recorder.record };
console.log(holder.record(next()).join(","), calls);
