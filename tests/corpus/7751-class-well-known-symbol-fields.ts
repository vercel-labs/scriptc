// Class fields keyed by well-known symbols, Symbol.toStringTag first (the
// lru-cache shape), beside toStringTag getters and module symbol keys.
// String conversion, Object.prototype.toString and util.inspect read the
// tag as Node does, through typed values and through `unknown`.

const limit = Symbol("limit");

class Cache {
  size = 0;
  [limit] = 10;
  [Symbol.toStringTag] = "LRUCache";
}

class Sub extends Cache {
  extra = 1;
}

class Retag extends Cache {
  constructor() {
    super();
    this[Symbol.toStringTag] = "Retagged";
  }
}

class Tagged {
  x = 1;
  get [Symbol.toStringTag](): string {
    return "Custom";
  }
}

class TaggedSub extends Tagged {
  y = 2;
}

class Named {
  get [Symbol.toStringTag](): string {
    return "Named";
  }
}

class Blank {
  get [Symbol.toStringTag](): string {
    return "";
  }
}

class Plain {
  n = 3;
}

const c = new Cache();
console.log(String(c), `${c}`, Object.prototype.toString.call(c), c[Symbol.toStringTag]);
console.log(c);
console.log(Object.keys(c), JSON.stringify(c));
console.log(new Sub(), String(new Sub()));
const r: Cache = new Retag();
console.log(String(r), r);
c[Symbol.toStringTag] = "Other";
console.log(`${c}`, c);

const t = new Tagged();
console.log(String(t), `${t}`, t, [t], { deep: { deeper: { t } } });
const ts: Tagged = new TaggedSub();
console.log(String(ts), ts);
console.log(new Named(), new Blank(), String(new Blank()));
console.log(String(new Plain()), new Plain());

const values: unknown[] = [new Cache(), new Tagged(), new TaggedSub(), new Plain()];
for (const v of values) {
  console.log(Object.prototype.toString.call(v), String(v), (v as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag]);
}
console.log(values);

const literal: unknown = { [Symbol.toStringTag]: "Literal", a: 1 };
console.log(Object.prototype.toString.call(literal), String(literal), `${literal}`);

// util.inspect ignores a Symbol.toStringTag getter that throws, typed or
// held as an untyped value.
class Throwing {
  get [Symbol.toStringTag](): string {
    throw new Error("tag");
  }
}
const throwing: unknown = new Throwing();
console.log(new Throwing(), [new Throwing()], throwing, [throwing]);

// A conversion to "[object Object]" still evaluates its receiver.
let made = 0;
function make(): Plain {
  made++;
  return new Plain();
}
function fail(): Plain {
  throw new Error("receiver");
}
console.log(Object.prototype.toString.call(make()), String(make()), made);
try {
  console.log(Object.prototype.toString.call(fail()));
} catch (error) {
  console.log((error as Error).message);
}

// ToString of a class with valueOf and no toString reads its tag; the
// default hint calls valueOf.
class Valued {
  valueOf(): number {
    return 1;
  }
  get [Symbol.toStringTag](): string {
    return "Valued";
  }
}
const valued: unknown = new Valued();
console.log(String(valued), `${valued}`, [valued].join(), valued + "", Object.prototype.toString.call(valued));
