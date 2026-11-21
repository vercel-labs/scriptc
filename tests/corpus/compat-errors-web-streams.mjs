function shape(label, fn) {
  try { fn(); console.log(label, "ok"); }
  catch (e) { console.log(label, e.constructor.name, e.name, e.code, JSON.stringify(e.message)); }
}
shape("illegal controller", () => new ReadableStreamDefaultController());
shape("missing hwm", () => new ByteLengthQueuingStrategy({}));
shape("missing hwm2", () => new CountQueuingStrategy({}));
shape("locked writer", () => { const w = new WritableStream(); w.getWriter(); w.getWriter(); });
shape("locked reader", () => { const s = new ReadableStream(); s.getReader(); s.getReader(); });
