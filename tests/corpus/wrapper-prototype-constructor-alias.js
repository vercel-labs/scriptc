// A program's write to a wrapper prototype's `constructor` survives a later
// read of the prototype (t262-da A2). Reading `X.prototype` installs the
// program's own `X` as the prototype's `constructor` on the first install;
// a repeat read leaves the member alone, so the replacement an alias holds
// stays, as it does in Node. Deleting the member through the alias and
// preventing extensions is the same rule: the later read cannot reinstall a
// constructor on a non-extensible object.
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

// Deleting the constructor through the alias and preventing extensions: a
// later read of the prototype must answer the object as the program left it,
// without reinstalling the constructor or inserting into a non-extensible
// object.
delete alias.prototype.constructor;
show("deleted", !Object.getOwnPropertyNames(alias.prototype).includes("constructor"));
Object.preventExtensions(alias.prototype);
show("sealed", Object.isExtensible(alias.prototype));
readStringPrototype();
show("stillDeleted", !Object.getOwnPropertyNames(alias.prototype).includes("constructor"));
show("stillSealed", Object.isExtensible(alias.prototype));
show("member", typeof alias.prototype.toUpperCase);

// A prototype reached through its instance has not had its install yet: that
// runs on the first ordinary read of `Boolean.prototype`. Delete the member
// and prevent extensions first, and the install the later read owes cannot
// land, so the prototype stays as the program left it.
const booleanPrototype = Object.getPrototypeOf(new Boolean(false));
show("booleanBefore", Object.getOwnPropertyNames(booleanPrototype).includes("constructor"));
delete booleanPrototype.constructor;
Object.preventExtensions(booleanPrototype);
const booleanRead = Boolean.prototype;
show("booleanAfter", Object.getOwnPropertyNames(booleanRead).includes("constructor"));
show("booleanSealed", Object.isExtensible(booleanRead));
show("booleanMember", typeof booleanRead.constructor);

for (const line of lines.sort()) console.log(line);
