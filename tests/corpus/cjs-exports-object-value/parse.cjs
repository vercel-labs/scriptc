// A dependency whose namespace a parent module re-exports wholesale.
exports.parse = function parse(text) {
  return { text: text, tag: "cst" };
};
exports.visit = function visit(node) {
  return node.tag + "!";
};
