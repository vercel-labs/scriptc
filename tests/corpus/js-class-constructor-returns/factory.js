// Classes whose constructor returns a value: `new` answers that value.
const make = (options = {}) => {
  const fn = (...parts) => parts.join(options.separator ?? " ");
  fn.level = options.level ?? 1;
  return fn;
};

export class Joiner {
  constructor(options) {
    return make(options);
  }
}

export class Record {
  constructor(name, size) {
    const value = { name, size, kind: "record" };
    if (size > 10) return { ...value, large: true };
    return value;
  }
}

let constructed = 0;
export class Counted {
  constructor() {
    constructed++;
    return { id: constructed };
  }
}

const j = new Joiner({ separator: "-", level: 3 });
console.log(typeof j, j("a", "b", "c"), j.level);
const plain = new Joiner();
console.log(plain("x", "y"), plain.level);
console.log(JSON.stringify(new Record("box", 4)), JSON.stringify(new Record("crate", 40)));
console.log(new Counted().id, new Counted().id, constructed);
