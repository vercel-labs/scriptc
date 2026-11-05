// Classes in their own module, so their names carry the module prefix.
export abstract class Link {
  next: Link | null = null;
  abstract depth(n: number): number;
}

export class Even extends Link {
  depth(n: number): number {
    return n === 0 ? 0 : 1 + this.next!.depth(n - 1);
  }
}

export class Odd extends Link {
  depth(n: number): number {
    return n === 0 ? 0 : 2 + this.next!.depth(n - 1);
  }
}

export class Tree {
  child: Tree | null;
  constructor(n: number) {
    this.child = n === 0 ? null : new Tree(n - 1);
  }
}
