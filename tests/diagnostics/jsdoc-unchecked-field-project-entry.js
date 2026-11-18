// @ts-check
// The project's own JavaScript is checked, as tsc checks the files a project
// lists: a class field that carries a JSDoc type and no initializer reports
// strict's "has no initializer" error. Published JavaScript under node_modules
// is not checked (tsc's maxNodeModuleJsDepth of 0), so a dependency such as
// svelte may ship this shape and still compile: see the npm-static harness
// test for jsdoc-unchecked-fields.
class Widget {
  /** @type {string} */
  slot_def;

  /** @param {string} name */
  constructor(name) {
    this.name = name;
  }
}
// End with a nonblank context line so diagnostic snapshots carry no trailing whitespace.
console.log(new Widget("a").name);
