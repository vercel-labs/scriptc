// @requires-libnode
// A symbol is one identity on both sides of a Node island boundary: the
// well-known symbols and Symbol.for symbols are the same symbols, a unique
// symbol made on either side comes back as itself, and it works as a
// symbol where it lands (typeof, String, description, a Map key, a Set
// member, a property key of an object of either side).
import { sym, kept, same, symInfo, keep, put, sameAs, same2, typedSym, tagged, readSym, writeSym, hasSym, symKeys, readByName, hasByName, ownByName, bareObject, shadowedObject, iterable, stream, Stream } from "symbol-pkg";

function t(label: string, f: () => unknown): void {
  try {
    console.log(label + ":", f());
  } catch (e) {
    console.log(label + ": threw", String(e));
  }
}

// An island symbol of each kind, held by the program as `unknown`.
function str(x: unknown): string { return typeof x === "symbol" ? x.toString() : String(x); }
function desc(x: unknown): string { return typeof x === "symbol" ? String(x.description) : "not a symbol"; }
for (const kind of ["local", "nodesc", "empty", "registered", "iterator", "asyncIterator", "hasInstance", "toPrimitive", "toStringTag"]) {
  const s = sym(kind);
  t(kind + " typeof", () => typeof s);
  t(kind + " String()", () => String(s));
  t(kind + " toString()", () => str(s));
  t(kind + " description", () => desc(s));
  t(kind + " twice ===", () => sym(kind) === s);
  t(kind + " back in the island", () => same(s));
  t(kind + " island sees", () => symInfo(s));
  t(kind + " round trip", () => keep(s) === s);
  t(kind + " Map key", () => new Map<unknown, number>([[s, 1]]).get(sym(kind)));
  t(kind + " Set member", () => new Set<unknown>([s]).has(kept<unknown>()));
  t(kind + " indexOf", () => [s].indexOf(kept<unknown>()));
  t(kind + " Object.is", () => Object.is(s, kept<unknown>()));
}
t("a symbol is not a string", () => { try { return `${sym("local") as string}`; } catch (e) { return (e as Error).name; } });

// The same symbol on both sides: well-known, registered, unique.
t("island Symbol.iterator is the program's", () => sym("iterator") === Symbol.iterator);
t("island Symbol.asyncIterator is the program's", () => sym("asyncIterator") === Symbol.asyncIterator);
t("island Symbol.hasInstance is the program's", () => sym("hasInstance") === Symbol.hasInstance);
t("island Symbol.toPrimitive is the program's", () => sym("toPrimitive") === Symbol.toPrimitive);
t("island Symbol.toStringTag is the program's", () => sym("toStringTag") === Symbol.toStringTag);
t("program Symbol.iterator in the island", () => symInfo(Symbol.iterator));
t("program Symbol.asyncIterator in the island", () => { sym("asyncIterator"); return same(Symbol.asyncIterator); });
t("island Symbol.for is the program's", () => sym("registered") === Symbol.for("vs.shared"));
t("program Symbol.for in the island", () => symInfo(Symbol.for("vs.shared")));
t("program Symbol.for (new key) round trip", () => keep(Symbol.for("made.here")) === Symbol.for("made.here"));
t("keyFor of an island registered symbol", () => Symbol.keyFor(typedSym("registered")));
t("keyFor of an island unique symbol", () => String(Symbol.keyFor(typedSym("local"))));
const own = Symbol("mine");
t("program symbol in the island", () => symInfo(own));
put("mine", own);
t("program symbol twice", () => sameAs("mine", own));
t("program symbol same call", () => same2(own, own));
t("program symbol round trip", () => keep(own) === own);
const other = Symbol("mine");
t("two program symbols, one description", () => same2(own, other));
t("program symbol without description", () => symInfo(Symbol()));
const asUnknown: unknown = own;
t("program symbol as unknown round trip", () => keep(asUnknown) === own);
t("island fresh symbols differ", () => sym("fresh") === sym("fresh"));

// Symbols as property keys on objects that cross.
const o = tagged() as any;
const local = sym("local") as any;
t("island object, island symbol key", () => o[local]);
t("island object, registered key", () => o[Symbol.for("vs.shared")]);
t("island object, well-known key", () => o[Symbol.toStringTag]);
t("island object, tag", () => Object.prototype.toString.call(o));
t("island object, in", () => `${local in o} ${Symbol.for("vs.shared") in o} ${Symbol.for("absent") in o}`);
const mine = Symbol("mine");
t("program writes a symbol key on an island object", () => { o[mine] = "set natively"; return readSym(o, mine); });
t("island lists the keys", () => symKeys(o));
t("island writes a symbol key, program reads", () => { writeSym(o, mine, "set by island"); return o[mine]; });
t("program deletes a symbol key of an island object", () => { delete o[mine]; return `${hasSym(o, mine)} ${mine in o} ${symKeys(o)}`; });
const rec: any = { plain: 1 };
rec[mine] = "native value";
rec[Symbol.for("vs.shared")] = "native registered";
t("program object, island reads program symbol key", () => readSym(rec, mine));
t("program object, island reads registered key", () => readSym(rec, Symbol.for("vs.shared")));
t("program object, island has", () => hasSym(rec, mine));
t("program object, island lists", () => symKeys(rec));
t("program object, island writes symbol key", () => { writeSym(rec, local, "island wrote"); return String(rec[local]); });

// A registered key the island makes for itself, never sent across: the
// registry makes it the program's key of the same name.
const fresh: any = {};
fresh[Symbol.for("vs.fresh")] = "native registered";
t("program object, island reads a registered key it never held", () => readByName(fresh, "vs.fresh"));
t("program object, island has a registered key it never held", () => hasByName(fresh, "vs.fresh"));
t("program object, island own-checks a registered key it never held", () => ownByName(fresh, "vs.fresh"));

// Own-property probes of an island object answer by their intrinsics, whatever
// the object does with those names.
const bare = bareObject() as any;
t("null-proto island object, own", () => Object.prototype.hasOwnProperty.call(bare, Symbol.for("vs.bare")));
t("null-proto island object, enumerable", () => Object.prototype.propertyIsEnumerable.call(bare, Symbol.for("vs.bare")));
const shadowed = shadowedObject() as any;
t("shadowed methods, own", () => Object.prototype.hasOwnProperty.call(shadowed, Symbol.for("vs.shadow")));
t("shadowed methods, enumerable", () => Object.prototype.propertyIsEnumerable.call(shadowed, Symbol.for("vs.shadow")));
t("island iterable in a program for-of", () => { const out: number[] = []; for (const x of iterable()) out.push(x); return out.join(","); });

// The same crossings with the program's type saying `symbol`.

const typed: symbol = Symbol("typed");
t("typed symbol into the island", () => symInfo(typed));
t("typed symbol round trip", () => keep(typed) === typed);
t("typed symbol same call", () => same2(typed, typed));
const got: symbol = typedSym("local");
t("typed island symbol", () => `${typeof got} ${got.toString()} ${got.description}`);
t("typed island well-known", () => typedSym("iterator") === Symbol.iterator);

// Members of an island object keyed by well-known, registered and island symbols, read and called by the program.
const body = stream() as any;
t("Symbol.iterator read", () => typeof body[Symbol.iterator]);
t("Symbol.iterator call", () => { const it = body[Symbol.iterator](); return `${it.next().value} ${it.next().value} ${it.next().done}`; });
t("Symbol.asyncIterator read", () => typeof body[Symbol.asyncIterator]);
const events = body[Symbol.asyncIterator]();
const first = await events.next();
const second = await events.next();
const end = await events.next();
console.log("Symbol.asyncIterator call:", first.value, second.value, end.done);
t("Symbol.toPrimitive call", () => `${body[Symbol.toPrimitive]("number")} ${body[Symbol.toPrimitive]("string")}`);
t("Symbol.toStringTag read", () => body[Symbol.toStringTag]);
t("Symbol.hasInstance read", () => typeof (Stream as any)[Symbol.hasInstance]);
t("registered key call", () => body[Symbol.for("vs.method")]());
t("island key call", () => body[sym("local") as any]());
t("absent key", () => typeof body[Symbol.for("vs.absent")]);
t("Symbol.dispose call", () => { body[Symbol.dispose](); return body.closed; });
