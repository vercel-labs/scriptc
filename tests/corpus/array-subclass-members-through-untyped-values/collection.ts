// A live collection as a DOM runtime builds one: a class that extends Array
// and rebuilds itself in place from its source.
export class ElementList extends Array<string> {
  source: () => string[];
  refreshes = 0;
  constructor(source: () => string[]) {
    super();
    this.source = source;
    this.refresh();
  }
  refresh(): void {
    this.length = 0;
    for (const name of this.source()) this.push(name);
    this.refreshes++;
  }
  item(index: number): string | null {
    return index < this.length ? this[index] : null;
  }
  namedItem(name: string): string | null {
    return this.find((entry) => entry === name) ?? null;
  }
  get first(): string | null {
    return this.item(0);
  }
}

const tags: string[] = ["div", "span"];
export const LIVE: ElementList[] = [];

export function getElementsByTagName(): ElementList {
  const list = new ElementList(() => tags.slice());
  LIVE.push(list);
  return list;
}

export function appendTag(tag: string): void {
  tags.push(tag);
  for (let i = 0; i < LIVE.length; i++) LIVE[i].refresh();
}
