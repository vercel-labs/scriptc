let abortEvent!: Event;
const source = AbortSignal.timeout(0);
source.addEventListener(
  "abort",
  (event: Event) => {
    abortEvent = event;
  },
  { once: true },
);
await new Promise<void>((resolve) => setTimeout(resolve, 5));

const target = AbortSignal.abort();
target.addEventListener("abort", () => {
  console.log("throwing dispatch listener");
  throw new Error("dispatch listener failed");
});
target.addEventListener("abort", () => {
  console.log("later dispatch listener");
});

try {
  console.log("returned", target.dispatchEvent(abortEvent));
} catch (error) {
  console.log("caught", error instanceof Error ? error.message : String(error));
}
console.log("after dispatch");
