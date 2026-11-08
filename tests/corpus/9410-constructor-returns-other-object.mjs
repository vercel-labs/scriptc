// `new C()` answers what the constructor returns when that is an object,
// functions included. A JavaScript class whose constructor hands back a
// factory's function is how a builder library makes instances; the class
// is held in an untyped member and constructed from there.
function makeBuilder(options) {
  const builder = (...parts) => builder.prefix + parts.join(' ');
  builder.prefix = options && options.prefix !== undefined ? options.prefix : '> ';
  builder.Instance = Builder;
  return builder;
}

class Builder {
  constructor(options) {
    // eslint-disable-next-line no-constructor-return
    return makeBuilder(options);
  }
}

const library = makeBuilder();
const one = new library.Instance({ prefix: '# ' });
const two = new library.Instance();
console.log(typeof one, one('a', 'b'), two('c'), one instanceof Builder, one === two);
console.log(typeof new library.Instance().Instance, new one.Instance({ prefix: '' })('bare'));

// A plain object, an array and a Map come back the same way. The class
// reaches `new` as an untyped value here too: a construction the compiler
// types as the class has nowhere to hold another kind of object.
function construct(Class, argument) {
  return new Class(argument);
}
class Bag {
  constructor(kind) {
    if (kind === 'object') return { kind, own: true };
    if (kind === 'array') return [kind, 1];
    if (kind === 'map') return new Map([[kind, 2]]);
  }
}
const asObject = construct(Bag, 'object');
const asArray = construct(Bag, 'array');
const asMap = construct(Bag, 'map');
const asInstance = construct(Bag, 'instance');
console.log(JSON.stringify(asObject), asObject instanceof Bag, Array.isArray(asArray), asArray.join('+'));
console.log(asMap instanceof Map, asMap.get('map'), asInstance instanceof Bag, asInstance.constructor === Bag);

// A primitive return is ignored, and the constructed instance is answered.
class Stubborn {
  constructor(value) {
    return value;
  }
  name() {
    return 'stubborn';
  }
}
const kept = construct(Stubborn, 5);
const replaced = construct(Stubborn, { other: true });
console.log(kept instanceof Stubborn, kept.name(), replaced instanceof Stubborn, replaced.other);

// One class, many constructions, in any order.
const results = [];
for (const prefix of ['a', undefined, 'b']) {
  const made = prefix === undefined ? construct(Bag, 'instance') : new library.Instance({ prefix });
  results.push(typeof made === 'function' ? made('x') : String(made instanceof Bag));
}
console.log(results.join(','));

// The constructor runs once per `new`, whatever it returns.
let runs = 0;
class Counted {
  constructor() {
    runs += 1;
    return { run: runs };
  }
}
console.log(construct(Counted).run, construct(Counted).run, runs);
