// A dynamic `signal` read selects the AbortController unit, and nothing else:
// this program has no http at all, so the unit must stand alone.
const dyn = (value) => value;

const object = { signal: "plain" };
console.log("object", dyn(object).signal);

const controller = new AbortController();
console.log("signal", dyn(controller).signal.aborted);
dyn(controller).signal.addEventListener("abort", () => console.log("aborted"));
controller.abort();
console.log("after", dyn(controller).signal.aborted, controller.signal.reason.name);
