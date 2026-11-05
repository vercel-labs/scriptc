const fragment = /\1/;
console.log(fragment.source, fragment.test("\x01"), fragment.test("1"));

const composed = new RegExp("(a)" + fragment.source);
console.log(composed.source, composed.test("aa"), composed.test("a\x01"));
console.log(/(a)\2/.test("a\x02"), /\8/.test("8"), /(a)\1/.test("aa"));
console.log("\x01-\x01".replace(/\1/g, "x"));
