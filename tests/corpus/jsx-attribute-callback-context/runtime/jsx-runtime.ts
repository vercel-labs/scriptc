// The automatic runtime, with the attribute types that type the callbacks
// written in JSX attributes.
export type Props = { [name: string]: unknown };
export interface Element {
  type: string | Component;
  props: Props;
  key: string | undefined;
}
export type Component = (props: any) => Element;

export const Fragment = "#fragment";

export function jsx(type: string | Component, props: Props, key?: unknown): Element {
  return { type, props, key: key === undefined ? undefined : String(key) };
}

export const jsxs = jsx;

export namespace JSX {
  export type Element = import("./jsx-runtime.js").Element;
  export interface ElementChildrenAttribute {
    children: {};
  }
  export interface IntrinsicElements {
    button: {
      id?: string;
      onClick?: (event: { x: number; label: string }) => void;
      onFocus?: (this: { tag: string }, event: { x: number }) => void;
      children?: unknown;
      key?: unknown;
    };
    div: { id?: string; children?: unknown; key?: unknown };
    li: { id?: string; children?: unknown; key?: unknown };
    span: { id?: string; children?: unknown; key?: unknown };
    ul: { children?: unknown; key?: unknown };
  }
}
