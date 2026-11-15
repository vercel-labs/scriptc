/* A class field declared for its JSDoc type alone: Node defines it as
 * `undefined` when the constructor runs, and this class never assigns it.
 * Reading it yields undefined, whatever the annotation says. */
export class Widget {
	/** @type {string} */
	label_text;

	/** @param {string} name */
	constructor(name) {
		this.name = name;
	}

	describe() {
		return this.label_text + "|" + typeof this.label_text;
	}
}
