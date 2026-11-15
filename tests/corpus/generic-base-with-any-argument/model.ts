export class Base<P = any> {
  props: P | null = null;

  constructor(props?: P) {
    if (props !== undefined) this.props = props;
  }

  describe(): string {
    return `${typeof this.props}:${String(this.props)}`;
  }
}

export class Mid<Q> extends Base<Q> {}

export class Pair<A, B> {
  first: A | null = null;
  second: B | null = null;

  summary(): string {
    return `${String(this.first)}/${String(this.second)}`;
  }
}

export abstract class Abstract<P = any> {
  props: P | null = null;
  abstract label(): string;

  show(): string {
    return `${this.label()}(${String(this.props)})`;
  }
}
