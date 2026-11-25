// A workspace-linked package whose bare import resolves to its TypeScript
// source compiles from source, and the JavaScript modules that source
// reaches compile with it: a JS module importing another JS module, a JS
// re-export, and a JS class used from TypeScript.
import { Counter, greet, label, value } from "wsjs";

console.log(`value ${value}`);
console.log(greet("workspace"));
const counter = new Counter();
counter.increment();
console.log(label, counter.increment(), counter.count);
