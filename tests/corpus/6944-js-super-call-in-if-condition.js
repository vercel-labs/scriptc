// A derived constructor whose super() call leads an if condition's comma
// chain, as minifiers join `super(...); if (test) ...`: the base and the
// derived fields initialize first, then the test decides.

let count = 0;
class Base {
  constructor(name) {
    this.name = name;
    this.created = count++;
  }
}

class Checked extends Base {
  limit = 3;
  constructor(name, size) {
    if ((super(name), size > this.limit)) throw new RangeError(`${name}: ${size} > ${this.limit}`);
    else this.size = size;
  }
}

class Tagged extends Base {
  constructor(name, tag) {
    if ((super(name), (this.tag = tag), tag === undefined)) this.tag = "none";
  }
}

class Plain extends Base {
  constructor(name, flag) {
    if ((super(name), flag)) this.flag = "set";
    this.done = true;
  }
}

const made = [new Checked("a", 2), new Tagged("b", "x"), new Tagged("c"), new Plain("d", 1)];
for (const value of made) console.log(JSON.stringify(value));
try {
  new Checked("e", 9);
} catch (error) {
  console.log(error.name, error.message, count);
}
console.log(new Plain("f", 0).flag, count);
