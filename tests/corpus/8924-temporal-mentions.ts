// Node 24 defines no Temporal global, and only a reference to that global
// asks for TypeScript's Temporal declarations. A comment that mentions
// Temporal, a string that holds the word, a member that carries the name
// and a program's own binding of it are not references: the checker's world
// stays as it is, which the type below observes.
type TemporalNames = Extract<keyof typeof globalThis, `Tempo${string}`>;
type Declared = [TemporalNames] extends [never] ? "undeclared" : "declared";
const declared: Declared = "undeclared";
console.log("global type:", declared);

// A program's own binding.
const Temporal = { now: (): string => "local clock" };
console.log(Temporal.now());

// A member that carries the name.
const features = { Temporal: false, Intl: true };
console.log(features.Temporal, Object.keys(features).join(","));

class Clock {
  Temporal = "member";
  describe(): string {
    return this.Temporal;
  }
}
console.log(new Clock().describe());

// A string and a computed read of the global object.
const name = "Temporal";
console.log(name.length, name in globalThis, (globalThis as Record<string, unknown>)[name]);

export {};
