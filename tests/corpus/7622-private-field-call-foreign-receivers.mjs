// A private field that holds a function, called by a prototype method whose
// receiver is known only at run time: the method reached by a computed name,
// as a detached value, through Reflect and as a callback. The field is read
// off the instance the private name belongs to and called with it as `this`;
// a receiver that is no instance throws Node's TypeError, also when it has a
// property spelled like the private name.
async function report(label, run) {
  try {
    console.log(label, await run());
  } catch (error) {
    console.log(label, error.constructor.name, error.message);
  }
}

var Reader = class {
  label;
  cache = {};
  #load = (key) => {
    const { cache, label } = this;
    return (cache[key] ??= Promise.resolve(`${label}:${key}`));
  };
  #format = function (text) {
    return `${text}!${this.label}`;
  };
  #hook = null;
  constructor(label) {
    this.label = label;
  }
  read() {
    return this.#load("text").then((text) => text.toUpperCase());
  }
  format(text) {
    return this.#format(text);
  }
  hooked(value) {
    return this.#hook(value);
  }
  setHook(hook) {
    this.#hook = hook;
    return this;
  }
};
class Loud extends Reader {
  read() {
    return super.read().then((text) => `${text}?`);
  }
}

const reader = new Reader("a");
const loud = new Loud("b");
console.log(await reader.read(), reader.format("x"), await loud.read(), loud.format("y"));
for (const target of [reader, loud])
  for (const name of ["read", "format", "hooked"])
    await report(`computed ${target.label} ${name}`, () => target[name]("z"));

const detached = reader.read;
await report("detached", () => detached.call(reader));
await report("detached on a subclass instance", () => detached.call(loud));
await report("reflect", () => Reflect.apply(Reflect.get(reader, "format"), loud, ["r"]));
console.log("callback", ["p", "q"].map(reader.format, reader).join(","));

reader.setHook((value) => `hook:${value}`);
console.log("hook", reader.hooked(1), reader["hooked"](2));
await report("hook cleared", () => reader.setHook(undefined)["hooked"](3));

const spelled = { label: "spelled", "#load": () => Promise.resolve("no"), "#format": (text) => text };
await report("plain read", () => Reader.prototype.read.call({ label: "plain" }));
await report("plain format", () => Reader.prototype.format.call({ label: "plain" }, "t"));
await report("spelled read", () => Reader.prototype.read.call(spelled));
await report("spelled format", () => Reader.prototype.format.call(spelled, "t"));
await report("undefined", () => Reader.prototype.format.call(undefined, "t"));
await report("null", () => Reader.prototype.read.call(null));
await report("number", () => Reader.prototype.format.call(4, "t"));
