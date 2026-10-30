// emit('error', payload) with a payload that is not an Error: with no
// 'error' listener it throws ERR_UNHANDLED_ERROR, whose message quotes
// util.inspect of the payload and whose context is the payload; listeners
// receive the arguments as given.
const { EventEmitter, errorMonitor } = require("events");

const e = new EventEmitter();
const payloads = ["Accepts a string", "it's", { message: "Error!" }, 42, -0, null, undefined, true, [1, "two"], { nested: { deep: [1, 2] } }];
for (const v of payloads) {
  try {
    e.emit("error", v);
    console.log("no throw");
  } catch (err) {
    console.log(err instanceof Error, err.name, err.code, err.message, err.context === v);
  }
}

try {
  e.emit("error");
} catch (err) {
  console.log(err.code, err.message, err.context);
}

try {
  e.emit("error", "first", "second");
} catch (err) {
  console.log(err.code, err.message, err.context);
}

// errorMonitor sees the payload before the throw.
const m = new EventEmitter();
m.on(errorMonitor, function (v) {
  console.log("monitor", v, arguments.length);
});
try {
  m.emit("error", { code: 7 });
} catch (err) {
  console.log("thrown", err.code, err.context.code);
}

// With an 'error' listener nothing throws.
const l = new EventEmitter();
l.on("error", function (a, b) {
  console.log("listener", a, b, arguments.length);
});
console.log(l.emit("error", "x", 2));
console.log(l.emit("error", { k: 1 }));
console.log(l.emit("error"));

// An Error payload still throws itself.
try {
  e.emit("error", new TypeError("typed"));
} catch (err) {
  console.log(err.name, err.message, err.code);
}

// A payload whose util.inspect throws is quoted by its string conversion.
try {
  e.emit("error", {
    message: "Error!",
    [require("util").inspect.custom]() {
      throw new Error("no inspect");
    },
  });
} catch (err) {
  console.log(err.code, err.message);
}
