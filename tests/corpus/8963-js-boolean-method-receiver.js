// Boolean.prototype.valueOf / toString read as values in a JavaScript
// source: the methods run thisBooleanValue on the receiver they are called
// with — a primitive boolean or a Boolean wrapper — and answer the
// primitive or "true"/"false". Any other receiver is Node's brand-check
// TypeError, whichever carrier holds the function. The prototype object
// itself is a Boolean wrapper of false, and it is the object instances
// inherit their members from.

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
const stored = { valueOf, toString };

show("typeof", () => typeof valueOf + " " + typeof toString);
show("length", () => valueOf.length + " " + toString.length);
show("name", () => valueOf.name + " " + toString.name);
show("identity", () => valueOf === Boolean.prototype.valueOf && toString === Boolean.prototype.toString);

show("valueOf-true", () => valueOf.call(true));
show("valueOf-false", () => valueOf.call(false));
show("toString-true", () => toString.call(true));
show("toString-false", () => toString.call(false));
show("valueOf-boxed", () => valueOf.call(new Boolean(false)));
show("toString-boxed", () => toString.call(new Boolean(true)));
show("valueOf-object-boxed", () => valueOf.call(Object(false)));
show("apply", () => valueOf.apply(true, []));
show("prototype-object", () => valueOf.call(Boolean.prototype) + " " + toString.call(Boolean.prototype));
show("bare", () => Boolean.prototype.valueOf() + " " + Boolean.prototype.toString());
show("instance", () => new Boolean(true).valueOf === valueOf);

show("stored", () => stored.valueOf.call(true) + " " + stored.toString.call(false));

show("alias", () => {
  const carrier = {};
  carrier.myValueOf = valueOf;
  return carrier.myValueOf.call(true);
});

show("number", () => valueOf.call(1));
show("string", () => toString.call("true"));
show("null", () => valueOf.call(null));
show("undefined", () => toString.call(undefined));
show("plain-object", () => valueOf.call({}));
show("string-wrapper", () => toString.call(new String("true")));
show("number-wrapper", () => valueOf.call(new Number(1)));
show("transplanted", () => {
  const carrier = { x: 1 };
  carrier.valueOf = valueOf;
  return carrier.valueOf();
});
