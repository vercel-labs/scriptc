// A void-declared call keeps its body's value, but these positions discard
// it in Node too: a parenthesized statement and a for head's initializer and
// incrementor. The calls run once, in order, for their effects.
const log = [];
let x = 0;

/** @returns {void} */
function gate(label) {
  log.push(label);
  return true;
}

(gate("paren"));
for (gate("init"); x < 2; gate("update")) {
  x += 1;
}
gate("plain");

console.log(log.join(","), x);
