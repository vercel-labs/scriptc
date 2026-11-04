// Class instances carrying expando properties: `C & { extra?: T }` maps to
// the checked-dynamic object model — the value IS the instance (identity,
// prototype, method dispatch), class fields read and write through the live
// view, and the extra members live in the instance's property table.
class Box {
  lines: string[] = [];
  w: number;
  h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }
  render(): string {
    return this.lines.join(",");
  }
  clear(): void {
    this.lines = [];
  }
  area(): number {
    return this.w * this.h;
  }
}

type EditCallRenderComponent = Box & {
  preview?: { text: string; at: number };
  previewArgsKey?: string;
  previewPending?: boolean;
  settledError?: boolean;
};

function create(key: string, pending: boolean): EditCallRenderComponent {
  return Object.assign(new Box(2, 3), {
    preview: undefined as { text: string; at: number } | undefined,
    previewArgsKey: key,
    previewPending: pending,
    settledError: false,
  });
}

// Object.assign answers its target: the instance, not a copy.
const component = create("k1", false);
console.log(component instanceof Box, component.area(), component.previewArgsKey);

// The expando members are the instance's own properties.
console.log(Object.keys(component).sort().join(","));

// Writes to the expando members, and reads of an absent optional member.
function build(c: EditCallRenderComponent, key: string): boolean {
  if (c.previewArgsKey === key) return false;
  c.previewArgsKey = key;
  c.previewPending = true;
  c.settledError = false;
  return true;
}
console.log(build(component, "k1"), build(component, "k2"), component.previewPending);

// The class fields write through the view and are visible natively.
component.lines = ["a", "b"];
console.log(component.render(), component.lines.length);

// ... and native writes are visible through the view.
const again: EditCallRenderComponent = component;
component.lines.push("c");
console.log(again.render());
component.clear();
console.log(component.render() === "", again.lines.length);

// Prototype methods dispatch on the same instance.
const same: Box = component;
console.log(same === component, same.area());

// A value with no expando member at all: the optional reads are undefined.
const plain: EditCallRenderComponent = new Box(1, 1);
console.log(plain.previewArgsKey === undefined, plain.preview === undefined);
plain.preview?.text;

// A REQUIRED expando member, and a second extra value shape.
type Decorated = Box & { label: string };
function decorate(target: Box, label: string): Decorated {
  return Object.assign(target, { label });
}
const decorated = decorate(new Box(4, 5), "tag");
console.log(decorated.label, decorated.area(), decorated.render() === "");

// The expando set through one view is the same property table another view
// reads: object identity, not a copy.
const viewA: Decorated = decorated;
const viewB: Decorated = decorated;
viewB.label = "tag2";
console.log(viewA.label, JSON.stringify(viewA.label));

// A function-valued expando member, called through the intersection.
class Container {
  children: number[] = [];
  addChild(value: number): void {
    this.children.push(value);
  }
  clear(): void {
    this.children = [];
  }
}
type Overlay = Container & { dispose?: () => void };
function showOverlay(overlay: Overlay): void {
  overlay.clear();
  overlay.addChild(overlay.children.length);
  overlay.dispose?.();
}
showOverlay(new Container());
const withDispose: Overlay = Object.assign(new Container(), {
  dispose: () => console.log("disposed"),
});
showOverlay(withDispose);
console.log(withDispose.children.length);
