import { Entry } from "./entry";
console.log("registry evaluated");
export class Registry {
  private entries: Entry[] = [];
  add(entry: Entry): void {
    this.entries.push(entry);
  }
  names(): string[] {
    return this.entries.map((entry) => entry.label());
  }
  size(): number {
    return this.entries.length;
  }
}
