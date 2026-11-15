import { Registry } from "./registry";
import { Options } from "./options";
console.log("entry evaluated");
export class Entry {
  constructor(
    private name: string,
    private owner: Registry,
    private options?: Options,
  ) {}
  label(): string {
    return `${this.name}#${this.owner.size()}`;
  }
}
