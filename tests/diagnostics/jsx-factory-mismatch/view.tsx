export function h(tag: string, props: object | null, ...children: string[]): string {
  return `<${tag}>${children.join("")}</${tag}>`;
}
declare global {
  namespace JSX {
    type Element = string;
    interface IntrinsicElements {
      [name: string]: object;
    }
  }
}
const count = 3;
export const view = <p>count: {count}</p>;
