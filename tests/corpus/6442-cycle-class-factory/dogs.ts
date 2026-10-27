import { Pet } from "./pets.ts";

export function describe(name: string): string {
  return `pet ${name}`;
}

export function makeDog(name: string): Pet {
  return new Pet(name);
}
