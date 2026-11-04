// A program's write to a wrapper prototype's `constructor` survives a later
// read of the prototype (t262-da A2). Reading `X.prototype` installs the
// program's own `X` as the prototype's `constructor` on the first install;
// a repeat read leaves the member alone, so the replacement an alias holds
// stays, as it does in Node.
const lines = [];
const show = (name, value) => lines.push(name + "=" + String(value));

const readStringPrototype = () => String.prototype;
const stringPrototype = readStringPrototype();
show("installed", stringPrototype.constructor === String);

// The alias holds the prototype object itself, and the write goes through a
// dynamic receiver rather than the `String.prototype.constructor` spelling
// the frontend refuses by name.
const alias = { prototype: stringPrototype };
alias.prototype.constructor = 42;
show("write", alias.prototype.constructor === 42);

readStringPrototype();
show("afterRead", alias.prototype.constructor === 42);
const descriptor = Object.getOwnPropertyDescriptor(alias.prototype, "constructor");
show("descriptor", descriptor.value === 42);
show(
  "attributes",
  [descriptor.writable, descriptor.enumerable, descriptor.configurable].join("|"),
);

// A prototype the program did not write keeps the identity the install gave
// it, across reads of the prototype it did write.
const numberPrototype = Number.prototype;
readStringPrototype();
show("untouched", numberPrototype.constructor === Number);

// A wrapper instance inherits the member the program wrote.
show("instance", new String("x").constructor === 42);

for (const line of lines.sort()) console.log(line);
