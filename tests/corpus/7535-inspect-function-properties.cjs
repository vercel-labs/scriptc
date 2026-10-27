// util.inspect of functions with own enumerable properties, as Node's
// formatRaw prints them: the function's base then its keys (symbols
// included), `[Function]` past the depth limit, and the plain base when
// every own property is hidden.
"use strict";
const util = require("util");

function named() {}
named.x = 1;
const arrow = () => {};
arrow.a = "s";
arrow[Symbol("k")] = 2;
Object.defineProperty(arrow, "hidden", { value: 3, enumerable: false });
function hiddenOnly() {}
Object.defineProperty(hiddenOnly, "secret", { value: 1, enumerable: false });
function big() {}
for (let i = 0; i < 8; i++) big["key" + i] = i;
function self() {}
self.me = self;

const pass = (value) => value;

console.log(named, arrow, hiddenOnly);
console.log(util.inspect(named, { depth: 0 }));
console.log(util.inspect(pass({ wrap: named }), { depth: 0 }));
console.log(util.inspect(pass([named, arrow])));
console.log(util.inspect(big));
console.log(util.inspect(self));
console.log(util.inspect(pass({ a: { b: { f: big } } })));
