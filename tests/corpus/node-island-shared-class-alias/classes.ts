export class Base {
  get x(): number {
    return 7;
  }
  m(): string {
    return "base:" + this.x;
  }
}

export class Derived extends Base {
  get x(): number {
    return 9;
  }
}

export const instance = new Derived();
export const baseInstance: Base = new Base();
