export class Shelf {
  readonly name: string;
  private readonly cursor = new Map<string, number>().keys();
  constructor(name: string) {
    this.name = name;
  }
  describe(): string {
    return `shelf ${this.name}`;
  }
}
