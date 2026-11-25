// The program's values for the declared globals, stored where Node keeps a
// global: on the global object. The `typeof` guards above ran before this.
(globalThis as any).document = {
  getElementById: (id: string) => (id === "x" ? { id } : null),
};
(globalThis as any).counter = 42;
