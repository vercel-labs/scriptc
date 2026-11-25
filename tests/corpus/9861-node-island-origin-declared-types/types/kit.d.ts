// The project's own declarations for a package that ships none: a global
// interface, and the module whose exports are typed with it.
interface Item {
  name: string;
  count: number;
  nested: { level: number };
  label(): string;
}

declare module "kit" {
  export const shared: Item;
  export const holder: { item: Item };
  export function make(name: string): Item;
  export function later(name: string): Promise<Item>;
  export function each(fn: (item: Item) => void): void;
  export function raw(name: string): unknown;
  export function take<T>(name: string): T;
  export function bump(): void;
  export function same(value: unknown): boolean;
  export function peek(): string;
  export function read(value: unknown): string;
}
