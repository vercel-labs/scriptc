export interface Settings {
  depth: number;
  label: string;
}
let current: Settings = { depth: 1, label: "first" };
export function replace(next: Settings): void {
  current = next;
}
export const reads: string[] = [];
// One live view for every importer: each read finds the current settings.
export const settings: Settings = new Proxy({} as Settings, {
  get(_target: any, key: string | symbol): any {
    reads.push(String(key));
    return (current as any)[key];
  },
});
