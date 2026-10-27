// The import source's createElement: TypeScript calls it for an element
// whose key follows a spread of props.
import { calls, type Element, type Props } from "./jsx-runtime.js";

export function createElement(type: string, props: Props | null, ...children: unknown[]): Element {
  calls.push(`createElement:${type}`);
  const all: Props = { ...props };
  if (children.length > 0) all["children"] = children.length === 1 ? children[0] : children;
  const key = all["key"];
  delete all["key"];
  return { type, props: all, key: key === undefined ? undefined : String(key) };
}
