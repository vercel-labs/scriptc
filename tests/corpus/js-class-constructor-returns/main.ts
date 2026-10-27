// The same classes constructed from TypeScript: the values come from the
// constructors' returns.
import { Counted, Joiner, Record } from "./factory.js";

// TypeScript types `new` by the class; the values are what the constructors return.
const joiner: any = new Joiner({ separator: "+" });
console.log(joiner("1", "2"));
const record = new Record("tube", 11);
console.log(JSON.stringify(record));
const counted: any = new Counted();
console.log(counted.id);
