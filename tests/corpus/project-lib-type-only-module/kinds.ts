export type { Span } from "./ruler.ts";
import type { Span } from "./ruler.ts";

export type Labelled = { label: string; span: Span; node: Element | null };

export function labelOf(node: Element): string {
  return node.getAttribute("aria-label") ?? node.tagName.toLowerCase();
}
