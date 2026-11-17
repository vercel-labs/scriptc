// A JavaScript override may declare parameter types unrelated to its base's.
// Node passes the call's arguments through: a call through the subclass
// supplies its own type, a call through a base-typed reference supplies the
// base's, and the body converts what it receives (string concatenation below).

class Base {
  /** @param {string} value */
  set(value) {
    this.value = value;
    return "base:" + value;
  }
}

class Derived extends Base {
  /** @param {number} value */
  set(value) {
    super.set(value);
    return "derived:" + (value + 1);
  }
}

const d = new Derived();
console.log("own", d.set(2), d.value);

const asBase = /** @type {any} */ (d);
console.log("via base", asBase.set("text"), d.value, typeof d.value);

console.log("method value", d.set(3), d.value);
