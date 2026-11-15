// @ts-check
// A checked JavaScript file holds subclasses whose constructors take other
// parameters than their base's in a slot of the base's class value type.
// Construction through the slot runs the held class's constructor with the
// arguments as written, as it does in TypeScript.
class Element {
  /** @param {string} [tag] */
  constructor(tag) {
    this.tag = tag ?? "x-el";
  }
  describe() {
    return "<" + this.tag + ">";
  }
}

/** @type {Map<string, typeof Element>} */
const registry = new Map();

class Labeled extends Element {
  /**
   * @param {string} [label]
   * @param {...string} rest
   */
  constructor(label = "untitled", ...rest) {
    super("labeled");
    this.label = label + (rest.length > 0 ? "+" + rest.join(",") : "");
  }
  describe() {
    return super.describe() + "[" + this.label + "]";
  }
}

class Plain extends Element {
  constructor() {
    super("plain");
  }
}

registry.set("labeled", Labeled);
registry.set("plain", Plain);
for (const name of ["labeled", "plain"]) {
  const C = registry.get(name);
  if (C === undefined) continue;
  const made = new C("given");
  console.log(name, new C().describe(), made.describe(), made instanceof Labeled, C.name);
}
