const child = require("./child.cjs");
console.log("len", module.children.length);
const c = module.children[0];
console.log("id", typeof c.id, c.id.endsWith("child.cjs"));
console.log("loaded", c.loaded);
console.log("filename", c.filename.endsWith("child.cjs"));
console.log("path", typeof c.path, c.path.length > 0);
console.log("isMain", c === require.main);
console.log("typeofElem", typeof module.children[0]);
console.log("grand", c.children[0].id.endsWith("grand.cjs"));
console.log("grandLen", c.children.length);
console.log("paths", Array.isArray(c.paths), c.paths.length > 0);
console.log("oor", module.children[9] === undefined);
console.log("mainIdType", typeof require.main.id, require.main.id.length > 0);
console.log("parentIsMain", c.parent.id === require.main.id);
console.log("eqMain", c.parent === require.main, c.parent === module, module === require.main);
const heldParent = c.parent;
require("./other.cjs");
console.log("live", heldParent.children.length, module.children.length, heldParent.loaded);
const heldChildren = module.children;
const heldCount = heldChildren.length;
require("./other.cjs");
console.log("liveChildren", heldCount, heldChildren.length, module.children.length);
const moduleAlias = module;
console.log("alias", moduleAlias === require.main);
console.log("hasParent", "parent" in c);
console.log("exitTag", child.tag);
console.log("iter", module.children.map((m) => m.id.endsWith("child.cjs")).join(","));
const keptKids = module.children;
const keptCount = keptKids.length;
try {
  require("./boom.cjs");
} catch (e) {
  console.log("failedRequire", e.message);
}
console.log("keptChildren", keptCount, keptKids.length, module.children.length, keptKids === module.children);
const mainAlias = require.main;
const moduleAliasValue = module;
const parentAlias = module.children[0].parent;
console.log("aliases", mainAlias === module, moduleAliasValue === require.main,
  parentAlias === require.main, moduleAliasValue.children.length);
const aliasOfAlias = mainAlias;
console.log("aliasOfAlias", aliasOfAlias === module, aliasOfAlias.children[0].id.endsWith("child.cjs"),
  typeof aliasOfAlias.id);
