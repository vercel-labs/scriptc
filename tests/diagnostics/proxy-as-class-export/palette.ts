export class Palette {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  fg(text: string): string {
    return `${this.name}:${text}`;
  }
}
let current: Palette | undefined;
export function setCurrent(palette: Palette): void {
  current = palette;
}
// One live palette for every importer, as a Proxy typed as the class.
export const palette: Palette = new Proxy({} as Palette, {
  get(_target: any, key: string | symbol): any {
    if (!current) throw new Error("not initialized");
    return (current as any)[key];
  },
});
