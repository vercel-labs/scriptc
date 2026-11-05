// A read of a Node 24 global native code does not provide answers the
// constructor Node has — the eager module-init read shape
// (`const WebSocket = instanceOf(globalThis.WebSocket, …)`) must not throw,
// and everything a read observes matches Node: typeof, name, length,
// identity through every read form, `instanceof` false for every value, and
// a prototype carrying `constructor`. Constructing or calling the value is
// the refusal (SC2020, host-global), so that shape lives in the diagnostics
// corpus and the JS deferred-refusal harness test.
declare var WebSocket: { new (url: string): unknown; readonly prototype: object };
declare var BroadcastChannel: { new (name: string): unknown; readonly prototype: object };

// lib.dom and @types/node declare the global twice, an interface beside the
// `declare var`; the merged symbol is still the global.
interface WebSocket {
  readonly entryCount: number;
}

// The module-init read: no use, so no throw.
const eager = WebSocket;
const scope = globalThis as Record<string, unknown>;

console.log(typeof WebSocket, WebSocket.name, WebSocket.length);
console.log(typeof BroadcastChannel, BroadcastChannel.name, BroadcastChannel.length);
console.log(eager === WebSocket, scope.WebSocket === WebSocket);
console.log(scope["WebSocket"] === WebSocket, (globalThis as any).WebSocket === WebSocket);

// instanceof answers false for every value native code can produce: the
// constructor's prototype is an object no value's chain reaches.
console.log({} instanceof WebSocket, [] instanceof BroadcastChannel, eager instanceof WebSocket);
console.log(new Map() instanceof WebSocket, (1 as any) instanceof WebSocket);
console.log(("text" as any) instanceof WebSocket, (null as any) instanceof WebSocket);
// An ordinary function is not one either, and a class value is not.
function plain() {}
console.log(plain instanceof WebSocket, (() => 1) instanceof BroadcastChannel);
console.log((class {}) instanceof WebSocket);
// The value itself is a Function instance, as Node's class is.
console.log(WebSocket instanceof Function, BroadcastChannel instanceof Function);
console.log(WebSocket.prototype.constructor instanceof Function);

// A constant holding the value is the same constructor, in every answer.
const Alias = WebSocket;
const AliasChain = Alias;
console.log(Alias === WebSocket, AliasChain === Alias, Alias.name, Alias.length);
console.log(plain instanceof Alias, new Map() instanceof AliasChain);
console.log(Alias instanceof Function, Alias instanceof WebSocket);
console.log(Alias.prototype.constructor === Alias);

// The prototype link both ways. The prototype carries the constructor and
// nothing else: Node's class methods are surface native code does not have,
// which is the same refusal the value's construction reports.
console.log(WebSocket.prototype.constructor === WebSocket, typeof WebSocket.prototype);
console.log(WebSocket.prototype.constructor.name, typeof BroadcastChannel.prototype.constructor);

// Every read form answers the same value.
const boxed = { BroadcastChannel };
const cast = (globalThis as { WebSocket?: unknown }).WebSocket;
console.log(typeof boxed.BroadcastChannel, boxed.BroadcastChannel === BroadcastChannel);
console.log(typeof scope.BroadcastChannel, typeof scope["Performance"]);
console.log(typeof cast, cast === WebSocket);

// A capability probe over the value still sees a constructor, so the
// feature-detection branch runs the way Node runs it.
if (typeof WebSocket === "function") console.log("websocket constructor");
else console.log("no websocket constructor");
console.log(typeof WebSocket === "function");
