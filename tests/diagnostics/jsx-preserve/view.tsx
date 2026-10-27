declare global {
  namespace JSX {
    type Element = string;
    interface IntrinsicElements {
      [name: string]: object;
    }
  }
}
export const view = <p>kept as JSX</p>;
