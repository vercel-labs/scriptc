let observed = "not-called";
let listener;
const signal = AbortSignal.timeout(0);

function handleAbort() {
  observed =
    this === listener ? "listener" : this === signal ? "signal" : "other";
}

listener = { handleEvent: handleAbort };
signal.addEventListener("abort", listener);
let emptyListenerRegistered = false;
try {
  signal.addEventListener("abort", {});
  emptyListenerRegistered = true;
} catch {}
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("object abort listener this:", observed);
console.log("empty object listener registered:", emptyListenerRegistered);

export {};
