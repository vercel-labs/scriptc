import { Element, Text, createElement } from "dom-kit/runtime/dom";
import { Node } from "dom-kit/shared/node";

// The program extends a class the source package itself extends from its
// own base class.
class Button extends Element {
  constructor(label: string) {
    super("button");
    this.setAttribute("type", "submit");
    this.appendChild(new Text(label));
  }

  override serialize(): string {
    return `[${super.serialize()}]`;
  }
}

const root = createElement("div");
root.setAttribute("id", "app");
root.appendChild(new Text("Hello, "));
const button = root.appendChild(new Button("Send"));

console.log(root.serialize());
console.log(root.textContent);
console.log(button.parentNode === root, button instanceof Element, button instanceof Node);
console.log(button.getAttribute("type"), button.getAttribute("missing"));
console.log(Node.count, root.childNodes.map((child) => child.nodeName).join(","));

// The package's plain JavaScript, by the names its exports give it: one
// module typed by a declaration beside it, one by inference.
import { formatAttributes } from "dom-kit/attributes";
import { quote } from "dom-kit/quote";
const attributes: string = formatAttributes(new Map([["lang", "en"]]));
console.log(attributes.trim(), quote('say "hi"'));
