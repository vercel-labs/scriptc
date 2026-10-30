"use strict";

function attempt(label: string, write: () => void): void {
  try {
    write();
    console.log(label, "allowed");
  } catch (error) {
    console.log(label, (error as Error).name);
  }
}

const record = { count: 1, child: { count: 2 } };
const alias = record;
console.log("identity", Object.freeze(record) === alias);
attempt("field", () => { alias.count = 3; });
attempt("compound", () => { alias.count += 3; });
attempt("increment", () => { alias.count++; });
alias.child.count = 4;
console.log("state", record.count, record.child.count, Object.isFrozen(record), Object.isFrozen(record.child));

// Temporary checked views must neither own nor lose native integrity.
function throughUnknown(value: unknown): unknown {
  console.log("view", Object.isFrozen(value), Object.isSealed(value), Object.isExtensible(value));
  const descriptor = Object.getOwnPropertyDescriptor(value, "count")!;
  console.log("descriptor", descriptor.value, descriptor.writable, descriptor.configurable, descriptor.enumerable);
  return value;
}
const roundtrip = throughUnknown(record) as typeof record;
console.log("roundtrip", roundtrip === record);
attempt("roundtrip write", () => { roundtrip.count = 5; });
throughUnknown(record);

const sealed: { count: number; extra?: number } = { count: 1 };
console.log("seal identity", Object.seal(sealed) === sealed);
sealed.count = 2;
attempt("sealed delete", () => { delete sealed.extra; });
attempt("sealed add", () => { sealed.extra = 3; });
console.log("sealed", sealed.count, Object.isSealed(sealed), Object.isFrozen(sealed), Object.isExtensible(sealed));
const sealedPresent: { extra?: number } = { extra: 2 };
Object.seal(sealedPresent);
attempt("sealed present delete", () => { delete sealedPresent.extra; });
console.log("sealed present", sealedPresent.extra);

const fixedKeys: { count: number; extra?: number } = { count: 1, extra: 2 };
console.log("nonextensible identity", Object.preventExtensions(fixedKeys) === fixedKeys);
fixedKeys.count = 3;
delete fixedKeys.extra;
attempt("nonextensible add", () => { fixedKeys.extra = 4; });
console.log("nonextensible", fixedKeys.count, Object.hasOwn(fixedKeys, "extra"), Object.isSealed(fixedKeys));

let backing = 1;
const accessor = {
  get value(): number { return backing; },
  set value(next: number) { backing = next; },
};
Object.freeze(accessor);
accessor.value = 5;
console.log("accessor", accessor.value, Object.isFrozen(accessor));
console.log("empty", Object.isFrozen(Object.preventExtensions({})));
console.log("accessor only", Object.isFrozen(Object.seal({ get value() { return 1; } })));
