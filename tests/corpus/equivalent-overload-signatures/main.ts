/// <reference lib="dom" />
// lib.dom's `fetch` and @types/node's (undici) `fetch` merge into ONE
// overload set whose two signatures differ only in the order of the
// `URL | Request | string` members they accept. Union interning keeps arm
// order, so the two mapped signatures differ by union id alone; the mapper
// reads the set as one function. Otherwise a record holding it refuses to
// compile: pi's `Provider.streamSimple(options)` has `options.fetch` of
// exactly this type, reached through the overloaded
// `registerProvider(provider: Provider)` of its extension API, and the
// extension factory is the module's default export — the entry contract has
// to hold the factory's parameter type statically (SC2009). skipLibCheck
// keeps the ambient/lib.dom merge quiet, as a typical project config does,
// and the merge itself is the point.
//
// The factory is only ever HELD here (never called), the way a module's
// default-exported extension is: that is what pins the type at the entry
// contract. Its body still lowers, and the provider record it builds runs
// through `streamSimple`.

interface SimpleStreamOptions {
	fetch?: typeof globalThis.fetch;
}

interface AssistantMessageEventStream {
	done(): boolean;
}

interface Provider<TApi extends string = string> {
	api: TApi;
	streamSimple(options: SimpleStreamOptions): AssistantMessageEventStream;
}

interface ExtensionAPI {
	registerProvider(provider: Provider): void;
	registerProvider(name: string, config: { api: string }): void;
}

export type ExtensionFactory = (pi: ExtensionAPI) => void;

export function createExtension(): ExtensionFactory {
	const stream: AssistantMessageEventStream = { done: () => true };
	const provider: Provider = { api: "static", streamSimple: () => stream };
	console.log(`created:${provider.api}:${provider.streamSimple({}).done()}`);
	return (pi) => {
		pi.registerProvider(provider);
		pi.registerProvider("dynamic", { api: "dynamic" });
	};
}

export default createExtension();
