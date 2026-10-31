// A cleanup list of `() => void` callbacks that unregister process signal
// listeners: `handlers.push(() => process.off(signal, handler))` infers
// `Process` (the chained result type of `off`) against a void slot, which
// discards it — the closure's ABI is void.
const handlers: Array<() => void> = [];
const signals: NodeJS.Signals[] = ["SIGTERM"];
for (const signal of signals) {
  const handler = (): void => {
    console.log("named handler", signal);
  };
  process.on(signal, handler);
  handlers.push(() => process.off(signal, handler));
  handlers.push(() => process.removeListener(signal, handler));
}
console.log("registered", handlers.length);
for (const cleanup of handlers) cleanup();
console.log("cleaned", handlers.length);
