// `.name` of a function value whose static type cannot name a single
// declaration: a function is named where it is created (V8's
// SetFunctionName), so a read through a class field, a record member or a
// conditional answers the name of the function the value holds — not the
// property it was read through, and not one arm of the type.
//
// Both arms run in one program: each flag is a runtime comparison whose
// static type is boolean, so the value the field holds is a runtime fact.
const longArm = Math.random() < 2; // always true
const shortArm = Math.random() < 0; // always false

function long(a, b, c) {}
function short(a) {}
const named = function explicit(a) {};
const arrow = (a) => a;

function label(value) {
  return value.name === "" ? "<anonymous>" : value.name;
}

// A conditional over two functions: the value decides.
const chosen = longArm ? long : short;
console.log("conditional", label(chosen));
console.log("direct conditional", label(longArm ? long : short));
console.log("short conditional", label(shortArm ? long : short));

// A class field holds the value someone else created; the read names the
// function, not the field.
class Holder {
  constructor(pick) {
    this.fn = pick ? long : short;
  }
  static sfn = longArm ? short : long;
  get later() {
    return this.fn;
  }
}
const holder = new Holder(longArm);
const shortHolder = new Holder(shortArm);
console.log("field", label(holder.fn), label(shortHolder.fn));
const fieldAlias = holder.fn;
console.log("field binding", label(fieldAlias));
console.log("static field", label(Holder.sfn));
console.log("getter", label(holder.later), label(shortHolder.later));
function throughParam(fn) {
  return label(fn);
}
console.log("field param", throughParam(holder.fn), throughParam(shortHolder.fn));

// A record member: same rule through a property read.
const record = { fn: longArm ? long : short };
const shortRecord = { fn: shortArm ? long : short };
console.log("member", label(record.fn), label(shortRecord.fn));
const memberAlias = record.fn;
console.log("member binding", label(memberAlias));
console.log("member param", throughParam(record.fn), throughParam(shortRecord.fn));

// A property that CREATES the function names it: a method's key, an
// anonymous definition's key, and a named definition's own name.
const table = {
  method() {},
  anon: function () {},
  named: function inner() {},
  alias: long,
};
console.log("method", label(table.method));
console.log("anonymous initializer", label(table.anon));
console.log("named initializer", label(table.named));
console.log("aliased initializer", label(table.alias));

// Named definitions keep their own names everywhere.
console.log("declaration", label(long), label(short), label(named), label(arrow));

// `.length` rides the same value: the box reads the closure's own.
console.log("lengths", holder.fn.length, shortHolder.fn.length, record.fn.length);
