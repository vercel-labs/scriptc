// React's development warnings discard a logical whose right operand is a
// conditional of console.error calls.
function warnIfMissingRender(instance, Component) {
  instance.render ||
    (Component.prototype && typeof Component.prototype.render === "function"
      ? console.error("%s(...): No `render` method found on the returned component.", "App")
      : console.error("%s(...): No `render` method found, and its prototype has none.", "App"));
}
warnIfMissingRender({ render: null }, { prototype: { render() {} } });
warnIfMissingRender({ render: null }, { prototype: {} });
warnIfMissingRender({ render() {} }, { prototype: {} });

let warned = 0;
function warn(message) {
  warned++;
  console.log("warn:", message);
}
for (const props of [{ key: 1 }, {}, { key: "a", ref: null }]) {
  "key" in props && (typeof props.key === "string" ? warn("string key") : warn("number key"));
  props.ref === undefined || (props.ref === null ? warn("null ref") : warn("ref"));
}
console.log("warned", warned);
