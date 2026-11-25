// Computed writes from sloppy-mode and strict-mode code in one program, with
// the key as a name held in a variable and as a value that converts. Both
// modes store into a class instance's fields, its added properties and an
// error's own properties alike. A write strict mode refuses (a frozen,
// sealed or non-extensible instance, a read-only field, a frozen object)
// throws a TypeError there, whichever form names the key; sloppy code leaves
// a frozen object unchanged without an error.

class Gauge {
  constructor() {
    this.level = 1;
    this.unit = "bar";
  }
  get reading() {
    return this.level + this.unit;
  }
}

class Tagged extends Error {
  constructor(message) {
    super(message);
    this.code = 7;
  }
}

function converting(name) {
  return {
    toString() {
      return name;
    },
  };
}

function show(value) {
  return JSON.stringify(value) + " " + String(value.reading) + " " + Object.keys(value).join(",");
}

/** @param {any} value @param {string} key @param {any} stored */
function sloppyName(value, key, stored) {
  value[key] = stored;
}
function sloppyConverted(value, key, stored) {
  value[converting(key)] = stored;
}
/** @param {any} value @param {string} key @param {any} stored */
function strictName(value, key, stored) {
  "use strict";
  value[key] = stored;
}
function strictConverted(value, key, stored) {
  "use strict";
  value[converting(key)] = stored;
}

const strictWriters = [
  ["strict name", strictName],
  ["strict converted", strictConverted],
];
const writers = [
  ["sloppy name", sloppyName],
  ["sloppy converted", sloppyConverted],
  ...strictWriters,
];

// What each key stores: a value of the member's own type.
const stored = { level: 5, unit: "psi", added: 5 };

function attempt(title, make, forms) {
  for (const [form, write] of forms) {
    for (const key of Object.keys(stored)) {
      const value = make();
      let outcome = "ok";
      try {
        write(value, key, stored[key]);
      } catch (error) {
        outcome = error.constructor.name + ": " + error.message;
      }
      console.log(title, "|", form, key, "|", outcome, "|", show(value));
    }
  }
}

attempt("open", () => new Gauge(), writers);
attempt("frozen", () => Object.freeze(new Gauge()), strictWriters);
attempt("sealed", () => Object.seal(new Gauge()), strictWriters);
attempt("not extensible", () => Object.preventExtensions(new Gauge()), strictWriters);
attempt(
  "read-only level",
  () => Object.defineProperty(new Gauge(), "level", { writable: false }),
  strictWriters,
);

function others(forms) {
  for (const [form, write] of forms) {
    const open = new Tagged("boom");
    write(open, "code", 8);
    write(open, "extra", 9);
    write(open, "message", "quiet");
    console.log("error |", form, "|", open.code, open.extra, open.message, Object.keys(open).join(","));
    const frozen = Object.freeze({ level: 1 });
    const outcomes = [];
    for (const key of ["level", "added", "0"]) {
      try {
        write(frozen, key, 2);
        outcomes.push("ok");
      } catch (error) {
        outcomes.push(error.constructor.name + ": " + error.message);
      }
    }
    console.log("frozen object |", form, "|", outcomes.join("; "), "|", JSON.stringify(frozen));
  }
}

others(writers);
