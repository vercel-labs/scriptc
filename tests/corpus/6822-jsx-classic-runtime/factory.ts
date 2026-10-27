// A React-shaped factory for the pragma file: createElement and Fragment.
export const Fragment = "frag";

export function createElement(tag: string, props: object | null, ...children: unknown[]): string {
  const inner = children.map((child) => String(child)).join(",");
  return `${tag}${props === null ? "" : JSON.stringify(props)}(${inner})`;
}
