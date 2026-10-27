// A barrel whose re-exports load their modules lazily: a build plugin
// (real esbuild output, plain and whitespace/syntax minified) turns each
// re-export into a getter over a memoized loader of a lazily initialized
// ES module. Node's ES-module import of a CommonJS module reads every
// lexer-visible export when it links, so each module initializes once,
// before main runs, and the imports are snapshots (greet reassigns
// GREETING afterwards).
import { greet, GREETING, Counter, describe } from "gtlazy";
import { describe as wsDescribe, GREETING as wsGreeting } from "gtlazyws";

console.log("main start");
console.log(GREETING);
console.log(greet("a"));
console.log(GREETING);
const c = new Counter();
console.log(c.next(), c.next());
console.log(describe());
console.log(wsDescribe());
console.log(wsGreeting);
