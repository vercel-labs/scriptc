// A small server-side JSX runtime: h builds elements, render writes HTML.
export type Leaf = string | number | boolean | null | undefined | Element;
export type Child = Leaf | Leaf[];
export type Props = { [name: string]: unknown };
export type Component = (props: Props, children: Child[]) => Element;
export interface Element {
  tag: string;
  props: Props | null;
  children: Child[];
}

export const Fragment = "#fragment";

export function h(tag: string | Component, props: Props | null, ...children: Child[]): Element {
  if (typeof tag === "function") return tag(props ?? {}, children);
  return { tag, props, children };
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

export function render(child: Child): string {
  if (child === null || child === undefined || typeof child === "boolean") return "";
  if (typeof child === "string") return escape(child);
  if (typeof child === "number") return String(child);
  if (Array.isArray(child)) return child.map(render).join("");
  const inner = child.children.map(render).join("");
  if (child.tag === Fragment) return inner;
  let attributes = "";
  for (const [name, value] of Object.entries(child.props ?? {})) {
    if (value === false || value === undefined || value === null) continue;
    attributes += value === true ? ` ${name}` : ` ${name}="${escape(String(value))}"`;
  }
  return `<${child.tag}${attributes}>${inner}</${child.tag}>`;
}

declare global {
  namespace JSX {
    type Element = import("./html.js").Element;
    interface IntrinsicElements {
      [name: string]: object;
    }
  }
}
