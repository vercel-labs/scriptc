// The program's own values for the declared globals, stored where Node keeps
// a global: on the global object. Each write uses a different spelling the
// census recognizes — a member, a `global` alias, and a computed key.
(globalThis as any).document = {
  getElementById: (id: string) => (id === "x" ? { id } : null),
};
(global as any).counter = 41;
(globalThis as any)["flags"] = [true, false, true];
