// Symbol-keyed class fields whose keys are constants that no single literal
// spells: the description comes from a template literal or a concatenation
// over module constants (the AI SDK's
// `const marker = `vercel.ai.gateway.error.${name}`;
//  const symbol = Symbol.for(marker)` idiom). The key must fold to a stable
// module-level identity, keep its own distinctness from every other symbol,
// and still print Node's `[Symbol(description)]` spelling.
'use strict';

const { inspect } = require('util');

const family = 'gateway';
const kind = 'authentication';
const name = 'GatewayAuthenticationError';
const marker = `vercel.ai.${family}.error.${kind}.${name}`;
const kMarker = Symbol.for(marker);
// A second binding of the same registry name is the SAME symbol.
const kMarkerAgain = Symbol.for('vercel.ai.' + family + '.error.' + kind + '.' + name);
// An ordinary Symbol() keeps its own identity even when its description is
// produced by the same constants.
const kTicks = Symbol(`${family}-ticks`);
// Two symbols with equal descriptions in DIFFERENT classes are distinct.
const kEqualOne = Symbol(`${family}-equal`);
const kEqualTwo = Symbol(`${family}-equal`);

class Base {
  constructor(ticks) {
    this[kMarker] = true;
    this[kTicks] = ticks;
  }

  bump() {
    this[kTicks] += 1;
    return this[kTicks];
  }

  static hasMarker(value) {
    return typeof value === 'object' && value !== null && kMarker in value && value[kMarker] === true;
  }
}

class Tagged extends Base {
  constructor() {
    super(0);
    this[kEqualOne] = 'one';
  }
}

class Other extends Base {
  constructor() {
    super(100);
    this[kEqualTwo] = 'two';
  }
}

const tagged = new Tagged();
const other = new Other();
console.log('identity:', kMarker === kMarkerAgain, kTicks === kMarkerAgain);
console.log('instance:', tagged[kMarker], tagged[kTicks], tagged[kEqualOne]);
console.log('other:', other[kEqualOne], other[kEqualTwo]);
console.log('registry key:', Symbol.keyFor(kMarker), Symbol.keyFor(kTicks));
console.log('marker on a plain object:', Base.hasMarker({ [kMarker]: true }), Base.hasMarker({}));
console.log('in:', kMarker in tagged, kEqualOne in tagged, kEqualTwo in tagged);
console.log('bump:', tagged.bump(), tagged.bump());

// Reads through an untyped view ask the instance at run time.
function read(value, key) {
  return key in value ? value[key] : 'missing';
}
console.log('dynamic:', read(tagged, kMarker), read(tagged, kEqualTwo), read(tagged, kTicks));

// A class that declares the symbol fields itself keeps each slot; inspect
// prints the string keys first and then each symbol key with its folded
// description. (inspect of a SUBCLASS instance that inherits a symbol field
// from a base which declared it is a separate, pre-existing crash — SC1090-free
// today but "expected boolean ... got undefined" at run time — so the
// inheritance shapes above are checked by reads, not by inspect.)
class Leaf {
  constructor() {
    this.label = 'leaf';
    this[kMarker] = true;
    this[kTicks] = 5;
  }
}
console.log(inspect(new Leaf()));

// The class-body declaration form of the same key: `[k] = value` defines the
// field at class evaluation, before the constructor body runs.
const kBody = Symbol(`${family}-body`);
class Body {
  [kBody] = 'from-default';
  constructor() {
    this.plain = 1;
  }
}
const body = new Body();
console.log('class-body:', body[kBody], Object.keys(body));
console.log(inspect(body));
