// Prototype getters named like String.prototype's HTML methods (bold,
// italics, link, big): each read builds a callable that wraps its input.
const wrap = (tag) => ({
  get() {
    const parent = this;
    const builder = (text) => builder.prefix(text);
    builder.prefix = (text) => parent.prefix(`<${tag}>` + text + `</${tag}>`);
    Object.setPrototypeOf(builder, proto);
    return builder;
  },
});
const proto = Object.defineProperties(() => {}, {
  bold: wrap("b"),
  italics: wrap("i"),
  link: wrap("a"),
  big: wrap("big"),
  red: wrap("red"),
});
const root = (text) => text;
root.prefix = (text) => text;
Object.setPrototypeOf(root, proto);
export default root;
