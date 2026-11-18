// `arguments.length` in a typed function with a rest parameter counts every
// argument the caller passes, including those the rest array holds: the
// hidden actual-argument list is the call itself, while the rest array only
// carries the arguments after the named positions. A rest parameter typed as
// a tuple names each position, and the count still follows them; a
// constructor with a rest parameter counts the same way.
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

function pair(...args: [number, string]): string {
  return `${arguments.length}:${args[0]}:${args[1]}`;
}

function headPair(head: number, ...args: [string, boolean]): string {
  return `${arguments.length}:${head}:${args[0]}:${String(args[1])}`;
}

function empty(...args: []): string {
  return `${arguments.length}:${args.length}`;
}

const tuple: [number, string] = [2, "t"];
console.log(pair(1, "a"), pair(...tuple), headPair(0, "x", true), empty());

class Collected {
  text: string;
  constructor(...values: number[]) {
    this.text = `${arguments.length}:${values.join("+")}`;
  }
}

class Labelled {
  text: string;
  constructor(label: string, ...values: number[]) {
    this.text = `${arguments.length}:${label}:${values.join("+")}`;
  }
}

const more = [1, 2, 3];
console.log(new Collected().text, new Collected(1, 2).text, new Collected(...more).text);
console.log(new Labelled("l").text, new Labelled("l", 4, ...more).text);

class Inherits extends Collected {}

class Spreads extends Collected {
  constructor(...values: number[]) {
    super(...values, 0);
  }
}

const make = (C: typeof Collected, ...values: number[]): string => new C(...values).text;
console.log(new Inherits(1, 2).text, new Spreads(5, 6).text, make(Collected, 7), make(Inherits));
