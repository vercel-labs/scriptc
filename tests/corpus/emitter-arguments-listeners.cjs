// Listeners that read `arguments` receive every emitted argument, whether
// the event's other listeners and emits are typed or untyped: a function
// whose body reads `arguments` takes the whole argument list, not a
// prefix of the event's tuple.
const { EventEmitter } = require("events");

const e = new EventEmitter();
const counts = [];
e.on("numArgs", function () {
  counts.push(arguments.length);
});
e.on("foo", function () {
  counts.push(arguments.length);
});
e.on("foo", function () {
  const n = arguments.length;
  counts.push(n);
});
e.emit("numArgs");
e.emit("numArgs", null);
e.emit("numArgs", null, null);
e.emit("numArgs", null, null, null, null, null);
e.emit("foo", null, null, null, null);
console.log(counts.join(","));

// A listener reading its arguments by index, next to one with parameters.
const f = new EventEmitter();
f.on("pair", (a, b) => console.log("params", a, b));
f.on("pair", function () {
  console.log("arguments", arguments.length, arguments[0], arguments[1], arguments[2]);
});
f.emit("pair", 1, "two");
f.emit("pair", 3, "four", true);

// A once listener reading arguments, and a listener added during an emit.
const g = new EventEmitter();
g.once("tick", function () {
  console.log("once", Array.prototype.slice.call(arguments).join("|"));
  g.on("tick", function () {
    console.log("later", arguments.length);
  });
});
g.emit("tick", "a", "b", "c");
g.emit("tick", "d");
