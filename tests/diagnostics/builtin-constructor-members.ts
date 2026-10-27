// Builtin constructors have interned function values, but those values model
// only name, length and constructor. Every other static member or prototype
// read as a value reports SC2020 at the read, whether it is spelled directly,
// through globalThis or through an alias; it never reads undefined.
const mapPrototype = Map.prototype;
const datePrototype = Date.prototype;
const regExpPrototype = RegExp.prototype;
const promisePrototype = Promise.prototype;
const weakSetPrototype = WeakSet.prototype;
const frozen = Object.isFrozen;
const setPrototype = globalThis.Set.prototype;
const D = Date;
const aliasPrototype = D.prototype;
// End with a nonblank context line so diagnostic snapshots carry no trailing whitespace.
