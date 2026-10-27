// JSON.stringify reads class instances through their checked-dynamic
// property view. A class whose declared field holds a RegExp or a Promise,
// which the runtime JSON traversal cannot write, is refused at compile
// time, naming the field.
class Pattern {
  name = "digits";
  source = /\d+/g;
}

class Job {
  title = "fetch";
  pending = Promise.resolve(1);
}

class Catalog {
  title = "team";
  patterns: Pattern[] = [new Pattern()];
}

console.log(JSON.stringify(new Pattern()));
console.log(JSON.stringify(new Job()));
console.log(JSON.stringify({ catalog: new Catalog() }));
