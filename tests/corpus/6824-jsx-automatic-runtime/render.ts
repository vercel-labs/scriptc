// Renders elements to HTML-like text.
import type { Element } from "#jsx/jsx-runtime";

export function render(value: unknown): string {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(render).join("");
  const element = value as Element;
  const { children, ...rest } = element.props;
  const inner = render(children);
  if (element.type === "#fragment") return inner;
  let attributes = element.key === undefined ? "" : ` key="${element.key}"`;
  for (const [name, item] of Object.entries(rest)) attributes += ` ${name}=${JSON.stringify(item)}`;
  return `<${element.type}${attributes}>${inner}</${element.type}>`;
}
