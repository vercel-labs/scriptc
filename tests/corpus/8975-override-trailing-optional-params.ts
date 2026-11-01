// A subclass override that ADDS trailing optional parameters to a base
// method. The family's virtual slot carries those extra slots, so a
// base-typed call (which passes only the inherited parameters) reaches the
// override with the extra arguments omitted and the override's own defaults
// run — Node's answer exactly. Covers a default that reads `this` and an
// earlier parameter, an `?:` parameter with no default, a call that passes
// the extra argument directly on the derived type, a two-level chain where
// the middle class does not mention the extra parameter, and a dynamic
// collection of base-typed receivers.
class Component {
  children: string[] = [];
  addChild(component: string): void {
    this.children.push(component);
  }
  label(): string {
    return this.children.join(",");
  }
}

class Stack extends Component {
  options: number[] = [];
  override addChild(component: string, options: number = 0): void {
    super.addChild(component);
    this.options.push(options);
  }
}

class Tagged extends Stack {
  tags: string[] = [];
  override addChild(
    component: string,
    options: number = this.tags.length,
    tag?: string,
  ): void {
    super.addChild(component, options);
    this.tags.push(tag ?? "none");
  }
}

const stack = new Stack();
stack.addChild("a");
stack.addChild("b", 2);
const asComponent: Component = stack;
asComponent.addChild("c");
console.log(stack.label(), stack.options.join(","));

const tagged = new Tagged();
tagged.addChild("d");
tagged.addChild("e", 5, "x");
const asBase: Component = tagged;
asBase.addChild("f");
asBase.addChild("g");
console.log(tagged.label(), tagged.options.join(","), tagged.tags.join(","));

const family: Component[] = [stack, tagged];
for (const member of family) member.addChild("h");
console.log(family.map((member) => member.label()).join(" | "));

// The base's own method still answers when nothing overrides its slot in
// the receiver's class.
const plain = new Component();
plain.addChild("i");
console.log(plain.label());
