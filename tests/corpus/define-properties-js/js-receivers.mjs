// JavaScript: the receivers.
function msg(e) { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o, k) { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

function fn() { return 1; }
class Point { constructor() { this.x = 1; } }
const receivers = [["function", fn], ["array", [1, 2]], ["instance", new Point()], ["null proto", Object.create(null)], ["object", { a: 1 }]];
for (const [label, receiver] of receivers) {
  try {
    const same = Object.defineProperties(receiver, { tag: { value: label, enumerable: true }, hidden: { get() { return "h"; } } });
    console.log(label, same === receiver, receiver.tag, receiver.hidden, Object.keys(receiver).join(","));
  } catch (e) { console.log(label, msg(e)); }
}
