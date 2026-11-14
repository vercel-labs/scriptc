// A runtime function that hands out a Proxy view declares it `any` or as
// an interface, and typed callers reach the traps through it: member
// reads, method calls, `in`, and writes. One interface-typed function can
// return the view or a real instance of the class.
import { CSSStyleDeclaration, Element, getComputedStyle, styleTable, styleView } from "./style.ts";
import { fromPage } from "./page.js";

const byId = (id: string): Element => new Element(id);

const j = getComputedStyle(byId("j"));
console.log("j display=" + j.getPropertyValue("display"));
console.log("j color=" + j.color + " marginTop=" + j.marginTop);
console.log("j in", "marginTop" in j, "paddingLeft" in j);
j.paddingLeft = 7;
console.log("j written", j.paddingLeft, j.getPropertyValue("padding-left"), "paddingLeft" in j);
console.log("j same view", getComputedStyle(byId("j")) === j, j === j);

const el = byId("shared");
console.log("shared view", getComputedStyle(el) === getComputedStyle(el));

for (const proxied of [false, true]) {
  const v = styleView(byId("view"), proxied);
  console.log(
    "view",
    proxied,
    v.getPropertyValue("display"),
    v.color,
    "color" in v,
    v instanceof CSSStyleDeclaration,
  );
}

const t = styleTable(byId("table"));
t.borderTopWidth = "2px";
console.log("table", t.getPropertyValue("margin-top"), t.borderTopWidth, t["border-top-width"], "borderTopWidth" in t);

console.log("page", fromPage());
