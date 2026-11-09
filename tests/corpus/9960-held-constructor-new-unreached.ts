// `new` through a held constructor builds a wrapper object under Node and
// has no lowering: the statement that holds it refuses when it runs. A
// program that never reaches it builds and runs as under Node.
const held = String;
const kinds = { amount: Number, flag: Boolean };

function wrap(value: string): object {
  return new held(value);
}
function wrapAmount(value: string): object {
  return new kinds.amount(value);
}

const reach = process.argv.length > 99;
console.log("done", typeof wrap, typeof wrapAmount, reach ? typeof wrap("x") : "skipped");
console.log(held("12"), kinds.amount("12"), kinds.flag(""), reach ? wrapAmount("1") : "skipped");
