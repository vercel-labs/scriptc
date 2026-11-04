/**
 * An arrow the field initializer calls on the spot runs at the initializer's
 * position, so `in this` inside it sees the fields defined so far, as Node
 * does. An arrow the initializer only hands out runs later, when the whole
 * instance is built, so its answer sees every field.
 */
class Early {
  first = 1;
  laterSeen = (() => "later" in this)();
  firstSeen = (() => "first" in this)();
  missingSeen = (() => "missing" in this)();
  nestedSeen = (() => (() => "later" in this)())();
  genericSeen = (<T,>() => "later" in this)();
  later = 2;
}

const early = new Early();
console.log(
  early.laterSeen,
  early.firstSeen,
  early.missingSeen,
  early.nestedSeen,
  early.genericSeen,
);

class Escape {
  first = 1;
  getLater = () => "later" in this;
  later = 2;
}

const escape = new Escape();
console.log(escape.getLater());
