console.log("react evaluated");
var version = "19.3.1";
function createElement(type, props) {
  return { type: type, props: props, version: version };
}
module.exports = {
  version: version,
  createElement: createElement,
  Fragment: { kind: "fragment" },
};
