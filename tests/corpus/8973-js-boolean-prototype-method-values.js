// Boolean.prototype.valueOf / toString read as values in a JavaScript
// source: transplanting one onto a non-Boolean receiver is Node's
// brand-check TypeError, whichever carrier (String object, Number object,
// Object object, plain object) holds it and whichever name it stores it
// under. A dynamic Date fences the assignment itself, so no Date carrier
// here.

function report(label, fn) {
  try {
    console.log(label, "value=" + String(fn()));
  } catch (e) {
    console.log(label, e.name, e.constructor === TypeError);
  }
}

report("valueOf-string-object", () => {
  const target = new String();
  target.valueOf = Boolean.prototype.valueOf;
  return target.valueOf();
});
report("valueOf-string-object-alias", () => {
  const target = new String();
  target.myvalueOf = Boolean.prototype.valueOf;
  return target.myvalueOf();
});
report("valueOf-number-object", () => {
  const target = new Number();
  target.valueOf = Boolean.prototype.valueOf;
  return target.valueOf();
});
report("valueOf-number-object-alias", () => {
  const target = new Number();
  target.myvalueOf = Boolean.prototype.valueOf;
  return target.myvalueOf();
});
report("valueOf-object-object", () => {
  const target = new Object();
  target.valueOf = Boolean.prototype.valueOf;
  return target.valueOf();
});
report("valueOf-plain-object", () => {
  const target = { x: 1 };
  target.valueOf = Boolean.prototype.valueOf;
  return target.valueOf();
});
report("valueOf-plain-object-alias", () => {
  const target = { x: 1 };
  target.myvalueOf = Boolean.prototype.valueOf;
  return target.myvalueOf();
});

report("toString-plain-object", () => {
  const target = { x: 1 };
  target.myToString = Boolean.prototype.toString;
  return target.myToString();
});
report("toString-call-plain", () => Boolean.prototype.toString.call({}));
report("valueOf-call-number", () => Boolean.prototype.valueOf.call(1));
report("valueOf-call-string", () => Boolean.prototype.valueOf.call("false"));
report("valueOf-call-undefined", () => Boolean.prototype.valueOf.call(undefined));

report("valueOf-type", () => typeof Boolean.prototype.valueOf);
report("toString-type", () => typeof Boolean.prototype.toString);
