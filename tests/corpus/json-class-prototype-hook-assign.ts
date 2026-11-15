// A `toJSON` installed on a class prototype from a source the compiler cannot
// name: `Object.assign` over the prototype with a variable-held key set.
// No class declares `toJSON`, so the name census has to remember the hook
// anyway and keep every class on the runtime walk; JSON.stringify reads the
// inherited hook, with the member's key as its argument.
class Secret {
  secret = 42;
}
class Other {
  value = 1;
}

const source: Record<string, unknown> = {
  toJSON: (key: unknown) => ({ redacted: true, key }),
  extra: "ignored",
};
Object.assign(Secret.prototype as unknown as Record<string, unknown>, source);

console.log(JSON.stringify(new Secret()));
console.log(JSON.stringify({ secret: new Secret() }));
console.log(JSON.stringify([new Secret()]));

// The census is program-wide: a class with no hook of its own keeps the
// runtime walk too, and serializes its fields as Node does.
console.log(JSON.stringify(new Other()));

// A named source instead of a variable keeps the same answer.
class Named {
  secret = 5;
}
const named = { toJSON: () => ({ named: true }) };
Object.assign(Named.prototype as unknown as Record<string, unknown>, named);
console.log(JSON.stringify(new Named()));
