//#region src/helper/websocket/index.ts
/**
* A context for controlling WebSockets
*/
var WSContext = class {
	#init;
	constructor(init) {
		this.#init = init;
		this.raw = init.raw;
		this.url = init.url ? new URL(init.url) : null;
		this.protocol = init.protocol ?? null;
	}
	send(source, options) {
		this.#init.send(source, options ?? {});
	}
	raw;
	binaryType = "arraybuffer";
	get readyState() {
		return this.#init.readyState;
	}
	url;
	protocol;
	close(code, reason) {
		this.#init.close(code, reason);
	}
};
const createWSMessageEvent = (source) => {
	return new MessageEvent("message", { data: source });
};
/**
* Create a WebSocket adapter/helper
*/
const defineWebSocketHelper = (handler) => {
	return ((...args) => {
		if (typeof args[0] === "function") {
			const [createEvents, options] = args;
			return async function upgradeWebSocket(c, next) {
				const result = await handler(c, await createEvents(c), options);
				if (result) return result;
				await next();
			};
		} else {
			const [c, events, options] = args;
			return (async () => {
				const upgraded = await handler(c, events, options);
				if (!upgraded) throw new Error("Failed to upgrade WebSocket");
				return upgraded;
			})();
		}
	});
};
//#endregion
export { WSContext, createWSMessageEvent, defineWebSocketHelper };
