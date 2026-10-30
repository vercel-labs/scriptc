import { checkOptionalParameter } from "../../utils/url.js";
import { Node } from "./node.js";
//#region src/router/trie-router/router.ts
var TrieRouter = class {
	name = "TrieRouter";
	#node = new Node();
	add(method, path, handler) {
		for (const result of checkOptionalParameter(path) || [path]) this.#node.insert(method, result, handler);
	}
	match(method, path) {
		return this.#node.search(method, path);
	}
};
//#endregion
export { TrieRouter };
