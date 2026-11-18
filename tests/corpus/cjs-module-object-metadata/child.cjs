console.log("child", typeof module, typeof module.parent, typeof require.main);
console.log(
  "parent fields",
  module.parent === null,
  module.parent === require.main,
  module.parent.filename.endsWith("main.cjs"),
  module.parent.loaded,
  module.parent.children.length,
  module.parent.children[0] === module,
  require.main.children[0] === module,
);
module.exports = { id: module.id, loaded: module.loaded };
