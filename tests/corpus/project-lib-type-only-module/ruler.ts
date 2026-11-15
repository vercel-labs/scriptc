// Shared by a page script and a command-line report. The report needs only
// `Span`; the functions measure text in a page and name DOM types and globals.
export type Span = { from: number; to: number };

export function spanOfSelection(range: Range, root: HTMLElement): Span {
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const from = before.toString().length;
  return { from, to: from + range.toString().length };
}

export function visibleSpans(spans: readonly Span[], viewport: DOMRect): Span[] {
  const lineHeight = Number.parseFloat(getComputedStyle(document.body).lineHeight);
  const lines = Math.floor(viewport.height / lineHeight);
  return spans.filter((span) => span.from < lines * 80);
}
