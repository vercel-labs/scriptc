// The automatic runtime: jsx, jsxs and Fragment, with children in props.
export type Props = { [name: string]: unknown };
export interface Element {
  type: string;
  props: Props;
  key: string | undefined;
}
export type Component = (props: Props) => Element;

export const Fragment = "#fragment";
export const calls: string[] = [];

function element(kind: string, type: string | Component, props: Props, key?: unknown): Element {
  const name = typeof type === "function" ? "component" : type;
  calls.push(`${kind}:${name}${key === undefined ? "" : `#${String(key)}`}`);
  if (typeof type === "function") return type(props);
  return { type, props, key: key === undefined ? undefined : String(key) };
}

export function jsx(type: string | Component, props: Props, key?: unknown): Element {
  return element("jsx", type, props, key);
}

export function jsxs(type: string | Component, props: Props, key?: unknown): Element {
  return element("jsxs", type, props, key);
}

export namespace JSX {
  export type Element = import("./jsx-runtime.js").Element;
  export interface IntrinsicElements {
    [name: string]: object;
  }
}
