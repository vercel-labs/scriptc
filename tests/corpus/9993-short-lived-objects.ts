// Short-lived typed objects in a render-like loop: each iteration allocates a
// few dozen small class instances and records, holds some in typed arrays,
// passes some down three calls, stores some in a field of a longer-lived
// object (overwritten by the next iteration), captures some in closures that
// die with the iteration, builds strings, and drops everything.
//
// Modes: `leaf` uses only classes and records whose fields hold primitives
// and strings (no cycle is possible); `tree` uses a class that can form a
// cycle but never does; `linked` forms parent cycles the collector must find.
// This program owns no weak collection, so nothing observes a disposal;
// 9994-short-lived-objects-weak.ts is the same loop in a program that does.

class Attr {
  name: string;
  value: string;
  constructor(name: string, value: string) {
    this.name = name;
    this.value = value;
  }
}

class Style {
  prop: string;
  amount: number;
  important: boolean;
  constructor(prop: string, amount: number, important: boolean) {
    this.prop = prop;
    this.amount = amount;
    this.important = important;
  }
}

interface Props {
  id: number;
  label: string;
  on: boolean;
}

interface Point {
  x: number;
  y: number;
}

type Child = El | string | number | null;

class El {
  parent: El | null = null;
  children: Child[] = [];
  attrs: Attr[] = [];
  style: Style | null = null;
  tag: string;
  key: number;
  props: Props;
  constructor(tag: string, key: number, props: Props) {
    this.tag = tag;
    this.key = key;
    this.props = props;
  }
}

class Frame {
  current: El | null = null;
  lastProps: Props | null = null;
  lastAttr: Attr | null = null;
  depth = 0;
  renders = 0;
}

class Sink {
  length = 0;
  hash = 7;
  write(s: string): void {
    this.length += s.length;
    this.hash = (Math.imul(this.hash, 31) + s.charCodeAt(s.length >> 1)) | 0;
  }
}


// ---- leaf: nothing here can be on a cycle ----

function attrWeight(a: Attr, props: Props): number {
  return a.name.length + a.value.length + (props.on ? 1 : 0);
}

function writeAttr(sink: Sink, a: Attr, props: Props): number {
  sink.write(" " + a.name + '="' + a.value + '"');
  return attrWeight(a, props);
}

function writeStyle(sink: Sink, s: Style): number {
  sink.write(s.prop + ":" + s.amount + (s.important ? "!important;" : ";"));
  return s.amount;
}

function leafWrite(sink: Sink, attrs: Attr[], styles: Style[], props: Props): number {
  let n = 0;
  for (const a of attrs) n += writeAttr(sink, a, props);
  for (const s of styles) n += writeStyle(sink, s);
  return n;
}

function leafRender(frame: Frame, sink: Sink, i: number): number {
  const attrs: Attr[] = [];
  for (let k = 0; k < 8; k++) attrs.push(new Attr("data-" + k, "v" + (i + k)));
  const styles: Style[] = [];
  for (let k = 0; k < 4; k++) styles.push(new Style("margin", (i % 7) + k, k === 0));
  const props: Props = { id: i, label: "item-" + i, on: (i & 1) === 0 };
  frame.lastProps = props;
  frame.lastAttr = attrs[i & 7];
  let total = 0;
  const counter = (): number => {
    total += props.id & 15;
    return total;
  };
  const points: Point[] = [];
  for (let k = 0; k < 6; k++) points.push({ x: k, y: i & 31 });
  total += leafWrite(sink, attrs, styles, props);
  for (const p of points) total += (p.x * p.y) % 5;
  frame.renders++;
  return total + counter() + props.label.length;
}

// ---- tree and linked: `El` can be on a cycle ----

function buildEl(i: number, depth: number, link: boolean): El {
  const el = new El(depth === 0 ? "ul" : "li", i + depth, {
    id: i,
    label: "n" + depth,
    on: depth > 0,
  });
  el.attrs.push(new Attr("class", "c" + (i & 3)));
  el.attrs.push(new Attr("id", "e" + i));
  el.style = new Style("pad", depth, false);
  if (depth < 2) {
    for (let k = 0; k < 2; k++) {
      const child = buildEl(i + k + 1, depth + 1, link);
      if (link) child.parent = el;
      el.children.push(child);
    }
  }
  el.children.push("text-" + i);
  el.children.push(i & 63);
  el.children.push(null);
  return el;
}

function renderOpen(sink: Sink, el: El): number {
  sink.write("<" + el.tag);
  let n = 0;
  for (const a of el.attrs) n += writeAttr(sink, a, el.props);
  const style = el.style;
  if (style !== null) n += writeStyle(sink, style);
  sink.write(">");
  return n;
}

function renderEl(frame: Frame, sink: Sink, el: El, done: (() => number)[]): number {
  frame.depth++;
  let n = renderOpen(sink, el);
  for (const child of el.children) {
    if (child === null) continue;
    if (typeof child === "string") sink.write(child);
    else if (typeof child === "number") sink.write("#" + child);
    else n += renderEl(frame, sink, child, done);
  }
  sink.write("</" + el.tag + ">");
  done.push((): number => {
    frame.depth--;
    return el.key + (el.parent === null ? 0 : 1);
  });
  return n;
}

function treeRender(frame: Frame, sink: Sink, i: number, link: boolean, observe: boolean): number {
  const root = buildEl(i, 0, link);
  frame.current = root;
  frame.lastProps = root.props;
  const done: (() => number)[] = [];
  let n = renderEl(frame, sink, root, done);
  for (const f of done) n += f();
  frame.renders++;
  return n + (observe ? 1 : 0);
}

function run(mode: string, iterations: number): void {
  const frame = new Frame();
  const sink = new Sink();
  let total = 0;
  for (let i = 0; i < iterations; i++) {
    if (mode === "leaf") total += leafRender(frame, sink, i);
    else total += treeRender(frame, sink, i, mode === "linked", mode === "observed");
    total = total % 1000003;
  }
  console.log(mode, iterations, total, sink.length, sink.hash, frame.renders, frame.depth);
}

const mode = process.argv[2];
if (mode === undefined) {
  run("leaf", 300);
  run("tree", 300);
  run("linked", 300);
} else {
  run(mode, Number(process.argv[3] ?? "1000"));
}
