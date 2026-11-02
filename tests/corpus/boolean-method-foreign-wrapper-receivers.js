// Boolean.prototype.valueOf / toString read as values in a JavaScript
// source, called on the Number and String prototypes: those two prototype
// objects are wrappers around 0 and "", not Booleans, so Node's brand check
// refuses them like any other non-Boolean receiver. Boolean.prototype
// itself wraps false and answers, whichever of the two reads reaches it.

function show(label, fn) {
  try {
    const value = fn();
    console.log(label, typeof value, String(value));
  } catch (e) {
    console.log(label, e.name, e.message);
  }
}

const valueOf = Boolean.prototype.valueOf;
const toString = Boolean.prototype.toString;

show("number-prototype", () => valueOf.call(Number.prototype));
show("number-prototype-toString", () => toString.call(Number.prototype));
show("string-prototype", () => valueOf.call(String.prototype));
show("string-prototype-toString", () => toString.call(String.prototype));

show("boolean-prototype", () => valueOf.call(Boolean.prototype) + " " + toString.call(Boolean.prototype));
