export function h(tag: string | ((props: { count: number }) => string), props: object | null, ...children: string[]): string {
  return typeof tag === "string" ? `<${tag}>${children.join("")}</${tag}>` : tag(props as { count: number });
}
declare global {
  namespace JSX {
    type Element = string;
    interface IntrinsicElements {
      p: { title?: string };
    }
  }
}
function Count(props: { count: number }): string {
  return String(props.count);
}
export const view = <p title={1}>text <Count count="two" /></p>;
