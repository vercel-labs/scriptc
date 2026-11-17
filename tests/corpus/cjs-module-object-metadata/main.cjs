// The CommonJS Module object's metadata: `typeof` answers "object" for the
// module value wherever it comes from (the global, require.main, or a
// parent), and every field read goes through the compiled module registry —
// id, filename, path, loaded, isPreloading, paths, children, parent — for
// the entry module and for modules it requires.
console.log("entry", typeof module, typeof require.main, require.main === module);
console.log(
  "entry fields",
  module.filename.endsWith("main.cjs"),
  module.path.endsWith("cjs-module-object-metadata"),
  module.loaded,
  module.isPreloading,
  Array.isArray(module.children),
  Array.isArray(module.paths),
);
console.log(
  "main fields",
  require.main === module,
  require.main.loaded,
  require.main.children.length,
);

const childInfo = require("./child.cjs");
console.log(
  "after require",
  module.children.length,
  module.children[0] === module.children[0],
  childInfo.id.endsWith("child.cjs"),
  childInfo.loaded,
);

console.log(
  "resolve dirname",
  require.resolve("./child.cjs", { paths: [__dirname] }).endsWith("child.cjs"),
  require.resolve.paths("node:path"),
);
