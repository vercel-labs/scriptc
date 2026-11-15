// The program's values for the module-form globals, stored on the global
// object before any read.
(globalThis as any).document = {
  getElementById: (id: string) => (id === "x" ? { id } : null),
};
globalThis.counter = 7;
(globalThis as any).boots = 3;
