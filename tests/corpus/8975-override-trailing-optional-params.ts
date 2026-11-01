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

// A SIBLING override may declare FEWER parameters than the family slot
// reserves: legal TypeScript and JS, and the reserved arguments the caller
// passes are simply dropped here.
class Silent extends Component {
  seen: number[] = [];
  override addChild(_component: string): void {
    this.seen.push(this.children.length);
  }
}

const silent = new Silent();
silent.addChild("j");
const silentAsComponent: Component = silent;
silentAsComponent.addChild("k");
console.log(silent.label(), silent.seen.join(","));

// The shape pi's tui uses: the reserved parameter is an object-typed
// default, and the family mixes an override that names it with overrides
// that declare fewer parameters at two levels.
class Panel {
  out: string[] = [];
  paint(tag: string): void {
    this.out.push(tag);
  }
}

class Frame extends Panel {
  modes: string[] = [];
  override paint(tag: string, options: { loud?: boolean } = {}): void {
    super.paint(tag);
    this.modes.push(options.loud === true ? "loud" : "quiet");
  }
}

class Surface extends Panel {
  hits: number = 0;
  override paint(_tag: string): void {
    this.hits++;
  }
}

class Fancy extends Frame {
  notes: string[] = [];
  override paint(tag: string): void {
    super.paint(tag, { loud: true });
    this.notes.push(tag);
  }
}

let tracedCalls = 0;
function traced(options: { loud?: boolean }): { loud?: boolean } {
  tracedCalls++;
  return options;
}

const frame = new Frame();
const surface = new Surface();
const fancy = new Fancy();
const panels: Panel[] = [frame, surface, fancy];
for (const panel of panels) panel.paint("a");
// A two-parameter call through the reserving declaration still evaluates
// its second argument, and the shorter override drops the value.
const frameTyped: Frame = fancy;
frameTyped.paint("b", traced({ loud: true }));
frame.paint("c", { loud: false });
console.log(frame.out.join(","), frame.modes.join(","));
console.log(surface.out.join(","), surface.hits);
console.log(fancy.out.join(","), fancy.modes.join(","), fancy.notes.join(","), tracedCalls);
