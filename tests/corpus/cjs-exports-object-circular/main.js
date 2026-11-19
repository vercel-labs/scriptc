// A module of a require cycle holds the same exports object its peers and
// the entry hold, so writes made anywhere in the cycle are seen everywhere.
const a = require("./a");
const b = require("./b");
console.log(b.keysOfA(), b.same(a), b.tag(), a.fromB);
a.fromMain = 1;
console.log(b.keysOfA(), JSON.stringify(a));
