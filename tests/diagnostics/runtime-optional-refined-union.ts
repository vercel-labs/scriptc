// Structural refinements still need a named fence for multi-value storage.
// The class refinement below is accepted through a checked identity-preserving view.
type Item = { rect?: { width: number } };

function hasRect(item: Item | string): item is Item & { rect: { width: number } } {
  return typeof item !== "string" && item.rect !== undefined;
}

function recordWidths(items: (Item | string)[]): void {
  for (const item of items) {
    if (hasRect(item)) console.log(item.rect.width);
  }
}

class Animal {
  name: string;
  constructor(name: string) { this.name = name; }
}
class Dog extends Animal {
  bark(): string { return this.name; }
}

function isDog(animal: Animal | string): animal is Dog {
  return typeof animal !== "string" && animal instanceof Dog;
}

function classNames(animals: (Animal | string)[]): void {
  for (const animal of animals) {
    if (isDog(animal)) console.log(animal.bark());
  }
}

recordWidths([{ rect: { width: 1 } }, "plain"]);
classNames([new Dog("dog"), "plain"]);
