// Builtin globals read by name off the global object held as a value: the
// detection chain libraries use to find it. Each read answers what the bare
// name reads, so identity holds; a name Node does not define reads
// undefined, and a property the program adds reads back.
var root =
  typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : global;

function line(name, read) {
  var out;
  try {
    out = String(read());
  } catch (e) {
    out = "THROW " + e.message;
  }
  console.log(name + ": " + out);
}

// Member reads: the type and the identity with the bare name.
line("Headers", function () {
  return typeof root.Headers + " " + (root.Headers === Headers);
});
line("Request", function () {
  return typeof root.Request + " " + (root.Request === Request);
});
line("Response", function () {
  return typeof root.Response + " " + (root.Response === Response);
});
line("fetch", function () {
  return typeof root.fetch + " " + (root.fetch === fetch);
});
line("URL", function () {
  return typeof root.URL + " " + (root.URL === URL);
});
line("URLSearchParams", function () {
  return typeof root.URLSearchParams + " " + (root.URLSearchParams === URLSearchParams);
});
line("AbortController", function () {
  return typeof root.AbortController + " " + (root.AbortController === AbortController);
});
line("Symbol", function () {
  return typeof root.Symbol + " " + (root.Symbol === Symbol);
});
line("Promise", function () {
  return typeof root.Promise + " " + (root.Promise === Promise);
});
line("Object", function () {
  return typeof root.Object + " " + (root.Object === Object);
});
line("Array", function () {
  return typeof root.Array + " " + (root.Array === Array);
});
line("Error", function () {
  return typeof root.Error + " " + (root.Error === Error);
});
line("JSON", function () {
  return typeof root.JSON + " " + (root.JSON === JSON);
});
line("Math", function () {
  return typeof root.Math + " " + (root.Math === Math);
});
line("Map", function () {
  return typeof root.Map + " " + (root.Map === Map);
});
line("Buffer", function () {
  return typeof root.Buffer + " " + (root.Buffer === Buffer);
});
line("process", function () {
  return typeof root.process + " " + (root.process === process);
});
line("console", function () {
  return typeof root.console + " " + (root.console === console);
});
line("setTimeout", function () {
  return typeof root.setTimeout + " " + (root.setTimeout === setTimeout);
});
line("queueMicrotask", function () {
  return typeof root.queueMicrotask + " " + (root.queueMicrotask === queueMicrotask);
});
line("parseInt", function () {
  return typeof root.parseInt + " " + (root.parseInt === parseInt);
});
line("Blob", function () {
  return typeof root.Blob + " " + (root.Blob === Blob);
});
line("FormData", function () {
  return typeof root.FormData;
});
line("globalThis", function () {
  return (root.globalThis === root) + " " + (root.global === root);
});

// A literal key, a truthiness test, a typeof guard and an object pattern.
line("key Headers", function () {
  return typeof root["Headers"] + " " + (root["Headers"] === Headers);
});
line("truthy URL", function () {
  return root.URL ? "yes" : "no";
});
line("guard TextEncoder", function () {
  return typeof root.TextEncoder !== "undefined" ? "defined" : "missing";
});
line("pattern", function () {
  var { Math: math, JSON: json } = root;
  return (math === Math) + " " + (json === JSON);
});

// Uses of the values.
line("Object.keys", function () {
  return root.Object.keys({ a: 1, b: 2 }).join();
});
line("JSON.stringify", function () {
  return root.JSON.stringify([1, "two"]);
});
line("Math.max", function () {
  return root.Math.max(1, 2);
});
line("Symbol()", function () {
  return root.Symbol("d").toString() + " " + (root.Symbol.iterator === Symbol.iterator);
});
line("Array.isArray", function () {
  return root.Array.isArray([]) + " " + new root.Array(3).length;
});
line("new Map", function () {
  return new root.Map([[1, 2]]).get(1);
});
line("Buffer.from", function () {
  return root.Buffer.from("ab").length;
});
line("parseInt()", function () {
  return root.parseInt("12px");
});
line("process.pid", function () {
  return typeof root.process.pid;
});

// A name Node does not define, and a property the program adds.
line("absent", function () {
  return typeof root.noSuchName + " " + String(root.noSuchName) + " " + typeof root.self;
});
root.mine = 41;
line("own", function () {
  return typeof root.mine + " " + (root.mine + 1) + " " + (root.globalThis.mine === root.mine);
});
