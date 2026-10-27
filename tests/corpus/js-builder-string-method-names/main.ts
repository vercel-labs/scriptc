// A TypeScript caller reaching JavaScript builders whose member names
// collide with String.prototype methods: the receiver is a function, so
// each call reads the function's inherited getter, not the string method.
import builder from "./builder.js";

// TypeScript infers no members for the builder's prototype getters.
const tags: any = builder;

console.log(tags.bold("strong"));
console.log(tags.red.bold("nested"));
console.log(tags.italics.link("deep").length);
console.log(tags.big.red.italics("three"));
const chain = tags.link;
console.log(chain.bold("from a binding"));
