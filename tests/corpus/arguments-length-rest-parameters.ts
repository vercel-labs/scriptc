// `arguments.length` in a typed function with a rest parameter counts every
// argument the caller passes, including those the rest array holds: the
// hidden actual-argument list is the call itself, while the rest array only
// carries the arguments after the named positions.
function rest(...values: string[]): string {
  return `${arguments.length}:${values.join("-")}`;
}

function headRest(head: string, ...values: string[]): string {
  return `${arguments.length}:${head}:${values.join("-")}`;
}

console.log(rest(), rest("a"), rest("a", "b"));
console.log(headRest("h"), headRest("h", "a", "b"));

const many = ["a", "b", "c"];
console.log(rest(...many), headRest("h", ...many));
console.log(rest(...[]));

class Calls {
  collect(...values: number[]): string {
    return `${arguments.length}:${values.length}:${values.join("+")}`;
  }
}

const calls = new Calls();
console.log(calls.collect(), calls.collect(1), calls.collect(1, 2));
