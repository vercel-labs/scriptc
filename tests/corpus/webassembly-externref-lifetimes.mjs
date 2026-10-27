// Externref values the guest holds stay alive until it is done with them:
// an import's result returned through an export, and a table's or global's
// reference read into a local before the guest or JavaScript replaces it.
// Each object is created fresh, so the runtime holds the only reference.
// (The module's text is in tests/wasm-spec/corpus/externref-lifetimes.wat.)
const bytes = Buffer.from("AGFzbQEAAAABCAJgAAFvYAAAAhgCA2VudgRtYWtlAAADZW52BWNsZWFyAAEDBQQAAAAABAQBbwABBgYBbwHQbwsHQQYEc2xvdAMABWNlbGxzAQAEcGFzcwACCnRha2VHbG9iYWwAAwl0YWtlVGFibGUABA50YWtlQWNyb3NzQ2FsbAAFCjUEBAAQAAsOAQFvIwAhANBvJAAgAAsSAQFvQQAlACEAQQDQbyYAIAALDAEBbyMAIQAQASAACw==", "base64");

let made = 0;
let exports;
const env = {
  make: () => ({ id: ++made, label: `made ${made}`, items: [made, made * 2] }),
  clear: () => {
    exports.slot.value = null;
  },
};
exports = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env }).exports;

const describe = (v) => (v === null ? "null" : `${v.id} ${v.label} ${v.items.join("+")}`);
const fresh = (n) => ({ id: n, label: `fresh ${n}`, items: [n, n + 1] });

const passed = [];
for (let i = 0; i < 200; i++) passed.push(describe(exports.pass()));
console.log("pass", passed.length, passed[0], passed[199]);

const fromGlobal = [];
for (let i = 0; i < 200; i++) {
  exports.slot.value = fresh(i);
  fromGlobal.push(describe(exports.takeGlobal()));
}
console.log("global", fromGlobal[0], fromGlobal[199], describe(exports.slot.value));

const fromTable = [];
for (let i = 0; i < 200; i++) {
  exports.cells.set(0, fresh(1000 + i));
  fromTable.push(describe(exports.takeTable()));
}
console.log("table", fromTable[0], fromTable[199], describe(exports.cells.get(0)));

const acrossCall = [];
for (let i = 0; i < 200; i++) {
  exports.slot.value = fresh(2000 + i);
  acrossCall.push(describe(exports.takeAcrossCall()));
}
console.log("across call", acrossCall[0], acrossCall[199], describe(exports.slot.value));
