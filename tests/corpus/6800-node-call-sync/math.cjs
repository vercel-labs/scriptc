"use strict";
let calls = 0;
exports.add = (a, b) => a + b;
exports.greet = (name) => `hello, ${name}`;
exports.point = (x, y) => ({ x, y, label: `(${x}, ${y})` });
exports.squares = (n) => Array.from({ length: n }, (_, i) => i * i);
exports.nothing = () => {};
exports.echo = (...args) => args;
exports.flags = (n) => Array.from({ length: n }, (_, i) => i % 2 === 0);
exports.count = () => ++calls;
exports.say = (text) => {
  console.log(text);
};
