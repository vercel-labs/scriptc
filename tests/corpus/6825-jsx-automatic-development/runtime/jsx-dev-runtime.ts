// The development runtime: jsxDEV receives the key, whether the children
// are static, the element's source position and the calling `this`.
export const Fragment = "#fragment";

interface Source {
  fileName: string;
  lineNumber: number;
  columnNumber: number;
}

export function jsxDEV(
  type: string | ((props: { [name: string]: unknown }) => string),
  props: { [name: string]: unknown },
  key: unknown,
  isStatic: boolean,
  source: Source,
  self: unknown,
): string {
  const file = source.fileName.slice(source.fileName.lastIndexOf("/") + 1);
  const where = `${file}:${source.lineNumber}:${source.columnNumber}`;
  const owner = self === undefined ? "none" : typeof self;
  const name = typeof type === "function" ? type(props) : type;
  return `${name}{key=${String(key)} static=${isStatic} at=${where} self=${owner}}`;
}

export namespace JSX {
  export type Element = string;
  export interface IntrinsicElements {
    [name: string]: object;
  }
}
