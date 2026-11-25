// trace_events.createTracing requires at least one category:
// ERR_TRACE_EVENTS_CATEGORY_REQUIRED for an empty list, and the ordinary
// argument check when the list is missing. A listed category starts.
import trace_events from "node:trace_events";

const kind = (e) => (e instanceof TypeError ? "TypeError" : e instanceof RangeError ? "RangeError" : e instanceof Error ? "Error" : typeof e);
function shape(label, fn) {
  try {
    const value = fn();
    console.log(label, "ok", String(value));
  } catch (e) {
    console.log(label, kind(e), e.name, e.code, JSON.stringify(e.message));
  }
}

shape("empty categories", () => trace_events.createTracing({ categories: [] }));
shape("absent categories", () => trace_events.createTracing({}));
shape("string categories", () => trace_events.createTracing({ categories: "v8" }));
shape("one category", () => {
  const tracing = trace_events.createTracing({ categories: ["v8"] });
  const enabled = tracing.enabled;
  tracing.enable();
  const after = tracing.enabled;
  tracing.disable();
  console.log("tracing", enabled, after, tracing.enabled, typeof tracing.categories, tracing.categories.size, tracing.categories);
  return "made";
});
