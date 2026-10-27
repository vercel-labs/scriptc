import { HonoBase as Hono$1 } from "./hono-base.js";
import { RegExpRouter } from "./router/reg-exp-router/router.js";
import "./router/reg-exp-router/index.js";
import { SmartRouter } from "./router/smart-router/router.js";
import { TrieRouter } from "./router/trie-router/router.js";
import "./router/trie-router/index.js";
//#region src/hono.ts
/**
* The Hono class extends the functionality of the HonoBase class.
* It sets up routing and allows for custom options to be passed.
*
* @template E - The environment type.
* @template S - The schema type.
* @template BasePath - The base path type.
*/
var Hono = class extends Hono$1 {
	/**
	* Creates an instance of the Hono class.
	*
	* @param options - Optional configuration options for the Hono instance.
	*/
	constructor(options = {}) {
		super(options);
		this.router = options.router ?? new SmartRouter({ routers: [new RegExpRouter(), new TrieRouter()] });
	}
};
//#endregion
export { Hono };
