// A read of a Node 24 global native code does not provide answers the
// constructor Node has — the eager module-init read shape
// (`const FormData = instanceOf(globalThis.FormData, …)`) must not throw,
// and everything a read observes matches Node: typeof, name, length,
// identity through every read form, `instanceof` false for every value, and
// a prototype carrying `constructor`. Constructing or calling the value is
// the refusal (SC2020, host-global), so that shape lives in the diagnostics
// corpus and the JS deferred-refusal harness test.
declare var FormData: { new (): unknown; readonly prototype: object };
declare var WebSocket: { new (url: string): unknown; readonly prototype: object };

// lib.dom and @types/node declare the global twice, an interface beside the
// `declare var`; the merged symbol is still the global.
interface FormData {
  readonly entriesCount: number;
}

// The module-init read: no use, so no throw.
const eager = FormData;
const scope = globalThis as Record<string, unknown>;

console.log(typeof FormData, FormData.name, FormData.length);
console.log(typeof WebSocket, WebSocket.name, WebSocket.length);
console.log(eager === FormData, scope.FormData === FormData);
console.log(scope["FormData"] === FormData, (globalThis as any).FormData === FormData);

// instanceof answers false for every value native code can produce: the
// constructor's prototype is an object no value's chain reaches.
console.log({} instanceof FormData, [] instanceof WebSocket, eager instanceof FormData);
console.log(new Map() instanceof FormData, (1 as any) instanceof FormData);
console.log(("text" as any) instanceof FormData, (null as any) instanceof FormData);
// An ordinary function is not one either, and a class value is not.
function plain() {}
console.log(plain instanceof FormData, (() => 1) instanceof WebSocket);
console.log((class {}) instanceof FormData);
// The value itself is a Function instance, as Node's class is.
console.log(FormData instanceof Function, WebSocket instanceof Function);
console.log(FormData.prototype.constructor instanceof Function);

// A constant holding the value is the same constructor, in every answer.
const Alias = FormData;
const AliasChain = Alias;
console.log(Alias === FormData, AliasChain === Alias, Alias.name, Alias.length);
console.log(plain instanceof Alias, new Map() instanceof AliasChain);
console.log(Alias instanceof Function, Alias instanceof FormData);
console.log(Alias.prototype.constructor === Alias);

// The prototype link both ways. The prototype carries the constructor and
// nothing else: Node's class methods are surface native code does not have,
// which is the same refusal the value's construction reports.
console.log(FormData.prototype.constructor === FormData, typeof FormData.prototype);
console.log(FormData.prototype.constructor.name, typeof WebSocket.prototype.constructor);

// Every read form answers the same value.
const boxed = { WebSocket };
const cast = (globalThis as { FormData?: unknown }).FormData;
console.log(typeof boxed.WebSocket, boxed.WebSocket === WebSocket);
console.log(typeof scope.WebSocket, typeof scope["URLPattern"]);
console.log(typeof cast, cast === FormData);

// A capability probe over the value still sees a constructor, so the
// feature-detection branch runs the way Node runs it.
if (typeof FormData === "function") console.log("formdata constructor");
else console.log("no formdata constructor");
console.log(typeof FormData === "function");
