import { makeDog } from "./dogs.ts";
export class Pet {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  speak(): string {
    return this.name;
  }
}
export const first = makeDog("rex");
