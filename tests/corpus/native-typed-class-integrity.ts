// @transform-types
"use strict";

class Counter {
  count = 1;
  child = { count: 2 };
  increment(): void { this.count++; }
}
const counter = new Counter();
const alias = counter;
console.log("identity", Object.freeze(counter) === alias);
try { alias.increment(); }
catch (error) { console.log("method", (error as Error).name); }
alias.child.count = 3;
console.log("fields", counter.count, counter.child.count, Object.isFrozen(counter));

class FrozenInConstructor {
  count = 1;
  constructor() {
    Object.freeze(this);
    this.count = 2;
  }
}
try { new FrozenInConstructor(); }
catch (error) { console.log("constructor", (error as Error).name); }

class FrozenBase {
  constructor() { Object.freeze(this); }
}
class Derived extends FrozenBase {
  count = 1;
}
try { new Derived(); }
catch (error) { console.log("derived", (error as Error).name); }

class PrivateCounter {
  #count = 1;
  increment(): number { return ++this.#count; }
}
const privateCounter = Object.freeze(new PrivateCounter());
console.log("private", privateCounter.increment(), Object.isFrozen(privateCounter));

const freeze = Object.freeze;
const freezeAlias = freeze;
function localCounter(): Readonly<PrivateCounter> {
  const read = () => local.increment();
  const local = freezeAlias(new PrivateCounter());
  console.log("forward", read(), Object.isFrozen(local));
  return local;
}
const returned = localCounter();
console.log("returned", returned.increment(), Object.isFrozen(returned));
function inferredCounter() { return freezeAlias(new PrivateCounter()); }
console.log("inferred", inferredCounter().increment());

let structural: Readonly<PrivateCounter> = privateCounter;
console.log("structural identity", structural === privateCounter, structural.increment());
structural = { increment: () => 9 };
console.log("structural replacement", structural.increment());
function relay(value: Readonly<PrivateCounter>): { increment: () => number } { return value; }
console.log("relayed", relay(privateCounter) === privateCounter, relay(structural).increment());

class ViewHolder {
  view: Readonly<PrivateCounter>;
  constructor(view: Readonly<PrivateCounter>) { this.view = view; }
}
console.log("field", new ViewHolder(privateCounter).view.increment());
const publicView = freezeAlias(new Counter());
console.log("public view", publicView.count, Object.isFrozen(publicView));
try { publicView.increment(); }
catch (error) { console.log("public method", (error as Error).name); }

const sealed = Object.seal(new PrivateCounter());
const nonextensible = Object.preventExtensions(new PrivateCounter());
console.log("siblings", sealed.increment(), nonextensible.increment(),
  Object.isSealed(sealed), Object.isExtensible(nonextensible));

function shadowedObject() {
  const Object = { freeze: (value: PrivateCounter) => ({ value: value.increment() }) };
  return Object.freeze(new PrivateCounter()).value;
}
console.log("shadowed", shadowedObject());

// Declarations create own undefined properties before constructor stores.
class DeclaredFields {
  first?: number;
  marker = 1;
  last?: string;
  flag?: boolean;
  child?: { count: number };
  constructor() { Object.seal(this); }
}
const declared = new DeclaredFields();
console.log("declared keys", Object.keys(declared).join(","));
console.log("declared presence", Object.hasOwn(declared, "first"), Object.hasOwn(declared, "last"),
  Object.hasOwn(declared, "flag"), Object.hasOwn(declared, "child"));
const firstDescriptor = Object.getOwnPropertyDescriptor(declared, "first");
console.log("declared descriptor", firstDescriptor !== undefined,
  firstDescriptor?.value === undefined, firstDescriptor?.enumerable, firstDescriptor?.configurable);
try {
  declared.first = 4;
  declared.last = "kept";
  declared.flag = true;
  declared.child = { count: 5 };
  console.log("sealed declared writes", declared.first, declared.last, declared.flag, declared.child.count);
} catch (error) { console.log("sealed declared writes", (error as Error).name); }
function stringifyChecked(value: unknown): string { return JSON.stringify(value); }
console.log("declared JSON", stringifyChecked(declared));

class BareDerived extends FrozenBase {
  declared?: number;
}
try { new BareDerived(); console.log("bare derived allowed"); }
catch (error) { console.log("bare derived", (error as Error).name); }

class PrivateDeclared {
  #value?: number;
  constructor() { Object.freeze(this); }
  store(value: number): number { this.#value = value; return this.#value; }
}
console.log("private declared", new PrivateDeclared().store(6));

class ParameterPresence {
  before = Object.hasOwn(this, "parameter");
  beforeValue = Object.getOwnPropertyDescriptor(this, "parameter")?.value === undefined;
  beforeKeys = Object.keys(this).join(",");
  constructor(public parameter: number) {}
}
const parameter = new ParameterPresence(7);
console.log("parameter declaration", parameter.before, parameter.beforeValue, parameter.beforeKeys,
  Object.keys(parameter).join(","), parameter.parameter);

class DescriptorView {
  visible = 1;
  hidden = 2;
}
const inspected = new DescriptorView();
function hideProperty(value: unknown): void {
  Object.defineProperty(value, "hidden", { enumerable: false });
}
hideProperty(inspected);
console.log("typed descriptor", inspected);
const checkedInspection: unknown = inspected;
console.log("checked descriptor", checkedInspection);

class ResetDeclared {
  early = this.seed();
  value?: number;
  seed(): boolean { this.value = 8; return Object.hasOwn(this, "value"); }
}
const resetDeclared = new ResetDeclared();
console.log("declared reset", resetDeclared.early, resetDeclared.value, Object.keys(resetDeclared).join(","));
function preserveUndefined(value: unknown): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, "value");
  Object.defineProperty(value, "value", { enumerable: false });
  Object.defineProperty(value, "value", { value: undefined });
  console.log("required pending", descriptor?.value === undefined, Object.keys(value as object).join(","));
  return Object.getOwnPropertyDescriptor(value, "value")?.value === undefined;
}
class RequiredDeclared {
  marker = 1;
  value: number;
  seen = preserveUndefined(this);
  constructor() { this.value = 9; }
}
const requiredDeclared = new RequiredDeclared();
console.log("required declared", requiredDeclared.seen, requiredDeclared.value, Object.keys(requiredDeclared).join(","));
console.log("required inspection", requiredDeclared);
function freezeUndefined(value: unknown): void {
  Object.freeze(value);
  Object.defineProperty(value, "value", { value: undefined });
  console.log("frozen declared same", Object.getOwnPropertyDescriptor(value, "value")?.value === undefined);
}
class FrozenDeclared {
  value: number;
  constructor() { freezeUndefined(this); this.value = 9; }
}
try { new FrozenDeclared(); console.log("frozen declared allowed"); }
catch (error) { console.log("frozen declared", (error as Error).name); }
class ErasedDeclared {
  declare absent: number;
  actual = 1;
  constructor() {
    console.log("erased before store", Object.hasOwn(this, "absent"));
    this.absent = 2;
  }
}
console.log("erased declaration", Object.keys(new ErasedDeclared()).join(","));
class ErasedFrozenBase {
  value = 3;
  constructor() { Object.freeze(this); }
}
class ErasedFrozenChild extends ErasedFrozenBase { declare value: number; }
console.log("erased inherited", new ErasedFrozenChild().value);
