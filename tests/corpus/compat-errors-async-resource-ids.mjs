// AsyncResource's triggerAsyncId validation: an id that is not a safe
// integer of at least -1 is ERR_INVALID_ASYNC_ID with Node's message; -1 is
// the documented default and constructs.
import { AsyncResource } from "node:async_hooks";
function show(label, fn) {
  try { fn(); console.log(label, "ok"); }
  catch (e) { console.log(label, e.name, e.code, JSON.stringify(e.message)); }
}
show("bad trigger", () => new AsyncResource("demo", { triggerAsyncId: -2 }));
show("string trigger", () => new AsyncResource("demo", { triggerAsyncId: "x" }));
show("float trigger", () => new AsyncResource("demo", { triggerAsyncId: 1.5 }));
show("minus one", () => new AsyncResource("demo", { triggerAsyncId: -1 }));
show("good trigger", () => new AsyncResource("demo", { triggerAsyncId: 1 }));
