// TypeScript object literals passed to a JavaScript constructor whose
// options parameter is a destructuring pattern with a rest element: the
// literal's extra properties reach the rest object.
import { Agent } from "optkit";

console.log(new Agent().describe("a"));
console.log(new Agent({ keepAliveTimeout: 10 }).describe("b"));
console.log(new Agent({ maxOrigins: 2, keepAliveTimeout: 5, pipelining: 1 }).describe("c"));
console.log(new Agent({ factory: (origin) => "client(" + origin + ")" }).describe("d"));

class TracingAgent extends Agent {}
console.log(new TracingAgent({ pipelining: 3 }).describe("e"));
