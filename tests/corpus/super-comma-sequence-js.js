// The JavaScript side of super-comma-sequence.ts: a statement-level comma
// expression containing super(...) runs its operands in source order, with
// the base constructor and the derived field initializers at the super()
// call, as the separate statements a minifier joined would.
function log(label, value) {
  console.log("  " + label);
  return value;
}

class Base {
  constructor(origin) {
    console.log("  Base body", origin);
    this.origin = origin;
  }
}

class Joined extends Base {
  first = log("field first", 1);
  second = this.first + 1;
  constructor(origin) {
    super(log("super argument", origin)), log("after super", 0), this.tag = `${this.origin}:${this.second}`;
  }
}

class Leading extends Base {
  value = log("field value", "v");
  constructor(origin) {
    log("before super", 0), super(origin), log("after super " + this.value, 0);
  }
}

class Again extends Joined {
  extra = log("field extra", "e");
  constructor() {
    super("again"), this.tag = this.tag + "!", this.extra = this.extra + this.tag;
  }
}

console.log("joined:");
const joined = new Joined("j");
console.log(joined.origin, joined.first, joined.second, joined.tag);

console.log("leading:");
const leading = new Leading("l");
console.log(leading.origin, leading.value);

console.log("again:");
const again = new Again();
console.log(again.origin, again.tag, again.extra, again instanceof Joined, again instanceof Base);
