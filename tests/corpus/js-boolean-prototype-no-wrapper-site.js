// Boolean.prototype's methods called on the prototype object itself in a
// JavaScript source that creates no wrapper (no `new Boolean(...)` or
// `Object(value)`): the prototype is a Boolean wrapper of false, so
// valueOf answers false and toString answers "false", as in Node.

function show(label, fn) {
  try {
    const value = fn();
    console.log(label, typeof value, String(value));
  } catch (e) {
    console.log(label, e.name, e.message);
  }
}

show("valueOf", () => Boolean.prototype.valueOf());
show("toString", () => Boolean.prototype.toString());
show("String", () => String(Boolean.prototype));
show("template", () => `${Boolean.prototype}`);
show("valueOf-call-true", () => Boolean.prototype.valueOf.call(true));
show("toString-call-false", () => Boolean.prototype.toString.call(false));
show("valueOf-call-number", () => Boolean.prototype.valueOf.call(1));
show("typeof", () => typeof Boolean.prototype);
show("number-valueOf", () => Number.prototype.valueOf());
show("number-toString", () => Number.prototype.toString());
