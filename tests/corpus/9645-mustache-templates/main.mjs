// The published mustache@4.2.0, compiled natively, rendering templates.
// node_modules/mustache holds the package's two entry files, its license and
// its package.json, unmodified; node_modules/@types/mustache@4.2.6 is the
// declaration surface a native build of the package needs. The package is
// pre-class JavaScript: its parser keeps the tag expressions in `var`s that
// a nested function assigns and hands them to methods of its Scanner
// constructor function, and its Context and Writer are constructor
// functions with prototype methods.
import Mustache from "mustache";

const view = {
  title: "Joe",
  calc: function () {
    return 2 + 4;
  },
  items: [
    { name: "a", price: 1.5 },
    { name: "b", price: 2 },
  ],
  empty: [],
  html: "<b>&</b>",
  nested: { deep: { value: "x" } },
  on: true,
  off: false,
};

console.log("[" + Mustache.render("plain", {}) + "]");
console.log(Mustache.render("hi {{who}}", { who: "ada" }));
console.log(Mustache.render("{{title}} spends {{calc}}", view));
console.log(Mustache.render("{{#items}}{{name}}={{price}};{{/items}}{{^empty}}none{{/empty}}", view));
console.log(Mustache.render("{{html}} {{{html}}} {{&html}}", view));
console.log(Mustache.render("{{nested.deep.value}}{{! a comment }}{{missing}}|", view));
console.log(Mustache.render("{{#on}}on{{/on}}{{#off}}off{{/off}}{{^off}}not off{{/off}}", view));
console.log(Mustache.render("{{#items}}{{> row}}{{/items}}", view, { row: "[{{name}}]" }));
console.log(Mustache.render("<% title %> {{title}}", view, {}, ["<%", "%>"]));
console.log(Mustache.render("{{=<% %>=}}<% title %> {{title}}", view));
console.log(Mustache.render("a\n  {{#items}}\n  - {{name}}\n  {{/items}}\nz", view));
const tokens = Mustache.parse("hi {{who}}{{#a}}x{{/a}}");
console.log(tokens.length, tokens[0][0], tokens[0][1], tokens[1][0], tokens[1][1], tokens[1][3], tokens[2][0], tokens[2][5]);
console.log(Mustache.escape("<a href='x'>&\"`=/"));
console.log(Mustache.name, Mustache.version, Mustache.tags.join(" "));
try {
  Mustache.render("{{#open}}never closed", {});
} catch (e) {
  console.log(e.message);
}
try {
  Mustache.render("{{/stray}}", {});
} catch (e) {
  console.log(e.message);
}
try {
  Mustache.render(5, {});
} catch (e) {
  console.log(e.name + ": " + e.message);
}
