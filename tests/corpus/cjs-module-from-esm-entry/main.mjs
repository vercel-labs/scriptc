// A CommonJS module imported by an ES-module entry has no CommonJS
// main module: Node's require.main is undefined there, not the entry file.
import "./child.cjs";
console.log("entry", typeof require);
