// ERR_EVENT_RECURSION: an Event dispatched while it is already being
// dispatched. Node throws it from inside the listener (a listener's
// exception leaves dispatchEvent through nextTick), so the listener catches
// it and the dispatch call itself completes normally.
const kind = (e) => (e instanceof TypeError ? "TypeError" : e instanceof RangeError ? "RangeError" : e instanceof Error ? "Error" : typeof e);
function shape(label, fn) {
  try {
    fn();
    console.log(label, "ok");
  } catch (e) {
    console.log(label, kind(e), e.name, e.code, JSON.stringify(e.message));
  }
}

const target = new EventTarget();
const event = new Event("x");
let once = true;
target.addEventListener("x", () => {
  if (!once) return;
  once = false;
  try {
    target.dispatchEvent(event);
  } catch (e) {
    console.log("recursion", kind(e), e.name, e.code, JSON.stringify(e.message));
  }
});
target.dispatchEvent(event);
console.log("after recursion", event.target === target, event.eventPhase);

// A second event of the same type dispatches normally.
target.dispatchEvent(new Event("x"));
console.log("second", event.target === target);
shape("missing event", () => new EventTarget().dispatchEvent());
