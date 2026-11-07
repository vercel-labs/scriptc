export type Bag = { [key: string]: { moved: number } };
export function touch(bag: Bag): Bag {
  bag.third = { moved: 3 };
  return bag;
}
export function count(bag: Bag): number {
  return Object.keys(bag).length;
}
