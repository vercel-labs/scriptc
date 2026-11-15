// An untyped page script reads the same view.
import { Element, getComputedStyle, styleView } from "./style.ts";

export function fromPage() {
  const s = getComputedStyle(new Element("page"));
  const v = styleView(new Element("pg"), true);
  return [s.getPropertyValue("display"), s.marginTop, "color" in s, v.color, v.marginTop].join(" ");
}
