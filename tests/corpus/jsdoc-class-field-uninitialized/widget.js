/* A class field declared for its JSDoc type and never given an initializer,
 * the shape svelte 4's internal/dev.js ships for its `$$prop_def` family:
 * Node defines the field as `undefined` when the constructor runs, so the
 * declaration is valid JavaScript. tsc never checks this file (checkJs is
 * off unless the project opts in), and the checker's "has no initializer"
 * demand must not stop the build either. */
export class Widget {
	/** @type {Record<string, unknown>} */
	props_def;

	/** @type {string | undefined} */
	slot_def;

	/** @param {string} name */
	constructor(name) {
		this.name = name;
	}

	label() {
		return "widget:" + this.name;
	}
}

/** @param {Widget} widget */
export function snapshot(widget) {
	return [
		widget.label(),
		widget.props_def,
		widget.slot_def,
		"props_def" in widget,
		Object.keys(widget).join(","),
	].join("|");
}
