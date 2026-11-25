// Sloppy-mode `arguments` forwarded through Function.prototype.apply
// (signal-exit's processEmit shape): the function reads its arguments list
// but never writes an element or a parameter, and apply only reads it, so
// an unmapped copy behaves exactly like Node's aliased object. `this` in a
// plainly called sloppy function is the global object.
function original(ev, arg) {
  return { ev: ev, arg: arg, count: arguments.length, global: this === globalThis };
}

function wrapper(ev, arg) {
  if (ev === "exit") {
    var ret = original.apply(this, arguments);
    return ret;
  }
  return original.apply(this, arguments);
}

console.log(JSON.stringify(wrapper("exit", 3)));
console.log(JSON.stringify(wrapper("other")));

// A forwarded arguments list still carries the caller's extra arguments.
function forward(a) {
  return collect.apply(null, arguments);
}
function collect() {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
  return parts.join(",");
}
console.log(forward(10, 20, 30));
