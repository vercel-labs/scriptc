// A second runtime, selected per file with @jsxImportSource.
export const Fragment = "alt-fragment";

export function jsx(type: string, props: { children?: unknown }): string {
  return `${type}(${JSON.stringify(props.children ?? null)})`;
}

export function jsxs(type: string, props: { children: unknown[] }): string {
  return `${type}[${props.children.map((child) => JSON.stringify(child)).join(",")}]`;
}

export namespace JSX {
  export type Element = string;
  export interface IntrinsicElements {
    [name: string]: object;
  }
}
