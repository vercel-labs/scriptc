import { Pet } from "./pets.ts";
export class Dog extends Pet {}
export function makeDog(name: string): Pet {
  return new Dog(name);
}
