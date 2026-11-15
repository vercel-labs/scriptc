// The class is used as a value from another module, which makes its static
// table exist: building it at the module's initialization reads only the
// class's own statics, after the later subclass is defined too.
import { Node, Element } from "./dom.ts";

const ctor: any = Node;
const sub: any = Element;
const child = new Element();
child.parentNode = new Element();
console.log(ctor.ELEMENT_NODE, ctor.TEXT_NODE, child.parentElement !== null);
console.log(sub.ELEMENT_NODE, sub.tag, Object.keys(ctor).join(","), new Node().parentElement);
