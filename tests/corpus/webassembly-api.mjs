// The WebAssembly JavaScript API over modules translated to native code when
// the program is built: compile, instantiate, validate, Module, Instance,
// exported functions, memories, tables and globals, imports, linking two
// instances, every trap, link errors, the error classes, externref values
// and the asynchronous entry points. The modules are inline base64 literals
// (their text is in tests/wasm-spec/corpus/*.wat).
const api = Buffer.from("AGFzbQEAAAABLwlgAX8Bf2ACf38Bf2ABfwBgAABgAAF/YAJ+fgF+YAJ/fwJ/f2ABfQF9YAN/f38AAi0EA2VudgNsb2cAAgNlbnYEZmFpbAAAA2VudgRiYXNlA38AA2VudgNiaWcDfgADEhEAAAMBAQQFBgcAAAQAAAAICAQFAXABAggFBAEBAQQGFwN/AUEAC3wARAAAAAAAAApAC34AIwELB5kBEwZtZW1vcnkCAAV0YWJsZQEAB2NvdW50ZXIDAgJwaQMDBGJpZzIDBANhZGQABQVhcHBseQAGBGJ1bXAABwVtdWw2NAAIBmRpdm1vZAAJBm5hcnJvdwAKBnN0cmxlbgALBGdyb3cADAVwYWdlcwANCGNhbGxGYWlsAA4EdHJhcAAPB3JlY3Vyc2UAEARmaWxsABEEY29weQASCAEECQgBAEEACwICAwqHAhEHACAAQQJsCwcAIAAgAGwLBgAjABAACwcAIAAgAWoLCQAgASAAEQAACwsAIwJBAWokAiMCCwcAIAAgAX4LDAAgACABbSAAIAFvCwQAIAALIAEBfwJAA0AgACABai0AAEUNASABQQFqIQEMAAsLIAELBgAgAEAACwQAPwALCQAgABABQQFqC1kAAkACQAJAAkACQAJAAkAgAA4GAAECAwQFBgsAC0EBQQBuDwtB/////wcoAgAPC0EBQQJBABEBAA8LQQFBBxEAAA8LRAAAAAAAAPh/qg8LQYCAgIB4QX9tCwwAIABBAWoQEEEBagsLACAAIAEgAvwLAAsMACAAIAEgAvwKAAALCw4BAEEQCwhzY3JpcHRjAA==", "base64");
const linked = Buffer.from("AGFzbQEAAAABFwRgAn9/AX9gAX8Bf2ABfwBgA39/fwF/AjYEA2FwaQZtZW1vcnkCAAEDYXBpBXRhYmxlAXAAAgNhcGkHY291bnRlcgN/AQNhcGkDYWRkAAADBQQBAAIDBycEBHJlYWQAAQh1c2VUYWJsZQACCnNldENvdW50ZXIAAwRhZGQzAAQKJwQHACAALQAACwkAIAEgABEBAAsGACAAJAALDAAgACABEAAgAhAACw==", "base64");
const refs = Buffer.from("AGFzbQEAAAABHwZgAW8Bb2ACf28AYAF/AW9gAW8Bf2ACb38Bf2AAAX8DBwYAAQIDBAUEBQFvAQEKBgYBbwHQbwsHPAgEcmVmcwEABHNsb3QDAARrZWVwAAAFc3RvcmUAAQRsb2FkAAIGaXNOdWxsAAMEZ3JvdwAEBHNpemUABQosBgQAIAALCAAgACABJgALBgAgACUACwUAIADRCwkAIAAgAfwPAAsFAPwQAAs=", "base64");

const show = (v) => {
  if (typeof v === "bigint") return `${v}n`;
  if (Array.isArray(v)) return `[${v.map(show).join(", ")}]`;
  return String(v);
};
const attempt = (label, f) => {
  try {
    console.log(label, show(f()));
  } catch (e) {
    console.log(label, e instanceof Error ? `${e.name}: ${e.message}` : `threw ${show(e)}`);
  }
};

console.log(WebAssembly.validate(api), WebAssembly.validate(new Uint8Array([1, 2, 3])));
attempt("validate(5)", () => WebAssembly.validate(5));
const module = new WebAssembly.Module(api);
console.log(module instanceof WebAssembly.Module, module instanceof WebAssembly.Instance, String(module));
console.log(module);

const logged = [];
const env = {
  log: (v) => logged.push(`log ${v}`),
  fail(v) {
    if (v < 0) throw new RangeError(`negative ${v}`);
    return v * 10;
  },
  base: 41,
  big: 9007199254740993n,
};
const instance = new WebAssembly.Instance(module, { env });
console.log(logged.join(","), instance instanceof WebAssembly.Instance);
const x = instance.exports;
console.log(Object.keys(x).join(","), Object.isFrozen(x), Object.getPrototypeOf(x));
console.log(x.add.name, x.add.length, typeof x.add, x.add === instance.exports.add);

attempt("add", () => x.add(2, 3));
attempt("add coerced", () => x.add("40", { valueOf: () => 2 }));
attempt("add wraps", () => x.add(0x7fffffff, 1));
attempt("add missing", () => x.add(5));
attempt("apply double", () => x.apply(0, 21));
attempt("apply square", () => x.apply(1, 12));
attempt("bump", () => [x.bump(), x.bump(), x.counter.value]);
x.counter.value = 100;
attempt("bump after set", () => x.bump());
attempt("pi", () => x.pi.value);
attempt("set pi", () => {
  x.pi.value = 1;
});
attempt("big2", () => x.big2.value);
attempt("mul64", () => x.mul64(123456789n, 1000000007n));
attempt("mul64 wraps", () => x.mul64(-1n, 2n ** 63n));
attempt("mul64 number", () => x.mul64(1, 2));
attempt("divmod", () => x.divmod(-17, 5));
attempt("narrow", () => x.narrow(0.1));
attempt("strlen", () => x.strlen(16));

const bytes = new Uint8Array(x.memory.buffer);
console.log(bytes.length, String.fromCharCode(...bytes.subarray(16, 23)));
console.log(x.memory instanceof WebAssembly.Memory, x.table instanceof WebAssembly.Table, x.counter instanceof WebAssembly.Global);
attempt("grow", () => x.grow(1));
attempt("pages", () => x.pages());
console.log(x.memory.buffer.byteLength);
attempt("memory.grow", () => x.memory.grow(1));
attempt("memory.grow too far", () => x.memory.grow(2));
console.log(x.memory.buffer.byteLength, x.pages());
attempt("grow too far in wasm", () => x.grow(5));
x.fill(100, 0x41, 5);
x.copy(200, 100, 5);
console.log(String.fromCharCode(...new Uint8Array(x.memory.buffer, 200, 5)));
attempt("fill out of bounds", () => x.fill(x.memory.buffer.byteLength - 2, 0, 5));

attempt("callFail", () => x.callFail(4));
attempt("callFail throws", () => x.callFail(-1));
for (let k = 0; k <= 6; k++) attempt(`trap ${k}`, () => x.trap(k));
attempt("recurse", () => x.recurse(0));
try {
  x.trap(0);
} catch (e) {
  console.log(
    e instanceof WebAssembly.RuntimeError,
    e instanceof Error,
    e instanceof WebAssembly.LinkError,
    Object.keys(e).length,
    Object.prototype.hasOwnProperty.call(e, "name"),
  );
}
attempt("after traps", () => x.add(1, 1));

console.log(x.table.length);
attempt("table.get out of range", () => x.table.get(5));
attempt("table.grow", () => x.table.grow(1));
console.log(x.table.length);
x.table.set(2, x.add);
console.log(x.table.get(2) === x.add, x.table.length);
attempt("table.get past the end", () => x.table.get(3));

const linkedInstance = new WebAssembly.Instance(new WebAssembly.Module(linked), { api: x });
const y = linkedInstance.exports;
attempt("read", () => y.read(16));
attempt("useTable", () => y.useTable(1, 9));
attempt("useTable signature", () => y.useTable(2, 9));
attempt("useTable null", () => y.useTable(3, 9));
y.setCounter(7);
attempt("shared counter", () => x.counter.value);
attempt("add3", () => y.add3(1, 2, 3));

attempt("no imports", () => new WebAssembly.Instance(module));
attempt("missing module", () => new WebAssembly.Instance(module, {}));
attempt("imports not an object", () => new WebAssembly.Instance(module, 5));
attempt("not callable", () => new WebAssembly.Instance(module, { env: { ...env, log: 1 } }));
attempt("global type", () => new WebAssembly.Instance(module, { env: { ...env, base: "x" } }));
attempt("bigint global", () => new WebAssembly.Instance(module, { env: { ...env, big: 1 } }));
attempt("memory import", () =>
  new WebAssembly.Instance(new WebAssembly.Module(linked), {
    api: { memory: {}, table: x.table, counter: x.counter, add: x.add },
  }),
);
attempt("mutable global as number", () =>
  new WebAssembly.Instance(new WebAssembly.Module(linked), {
    api: { memory: x.memory, table: x.table, counter: 1, add: x.add },
  }),
);
attempt("signature mismatch", () =>
  new WebAssembly.Instance(new WebAssembly.Module(linked), {
    api: { memory: x.memory, table: x.table, counter: x.counter, add: x.bump },
  }),
);
attempt("Instance(5)", () => new WebAssembly.Instance(5));
attempt("Module(5)", () => new WebAssembly.Module(5));
try {
  new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 2, 0, 0, 0]));
} catch (e) {
  console.log(e.name, e instanceof WebAssembly.CompileError, e instanceof Error);
}

const custom = new WebAssembly.RuntimeError("custom", { cause: 5 });
console.log(String(custom), custom.name, custom.message, custom.cause);
console.log(custom instanceof WebAssembly.RuntimeError, custom instanceof WebAssembly.CompileError, custom instanceof Error);
console.log(String(WebAssembly.LinkError("called")), String(new WebAssembly.CompileError()));

const z = new WebAssembly.Instance(new WebAssembly.Module(refs)).exports;
const token = { id: 1 };
console.log(z.keep(token) === token, z.keep(null), z.keep(undefined), z.isNull(null), z.isNull(undefined), z.isNull(0));
z.store(0, token);
console.log(z.load(0) === token, z.refs.get(0) === token);
attempt("grow refs", () => z.grow("filler", 3));
console.log(z.size(), z.load(2), z.refs.length);
z.slot.value = token;
console.log(z.slot.value === token);
attempt("store out of range", () => z.store(10, token));

const order = [];
const compiled = WebAssembly.compile(api)
  .then((m) => {
    order.push(`compiled ${m instanceof WebAssembly.Module}`);
    return WebAssembly.instantiate(m, { env });
  })
  .then((i) => {
    order.push(`instance ${i instanceof WebAssembly.Instance} ${i.exports.add(1, 1)}`);
  });
const pair = WebAssembly.instantiate(api, { env }).then((result) => {
  order.push(`pair ${Object.keys(result).join(",")} ${result.instance.exports.add(2, 2)}`);
});
const rejected = WebAssembly.compile(new Uint8Array([1])).catch((e) => order.push(`rejected ${e.name}`));
const typeError = WebAssembly.instantiate(5).catch((e) => order.push(`${e.name}: ${e.message}`));
const linkError = WebAssembly.instantiate(api, {}).catch((e) => order.push(`${e.name}: ${e.message}`));
await Promise.all([compiled, pair, rejected, typeError, linkError]);
console.log(order.sort().join("\n"));
console.log(logged.length);
