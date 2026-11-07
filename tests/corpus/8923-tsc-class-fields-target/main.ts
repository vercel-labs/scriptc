// @tsc-emit
// A project that targets a release before ES2022 compiles class fields in
// the constructor, after its parameter properties: a field initializer may
// read a parameter property, directly or through a method. ES2022 class
// fields would run the initializer first and read undefined.
class Tokens {
  private widths: number[] = new Array<number>(this.tokens.length).fill(0);
  private first = this.head();
  constructor(
    readonly tokens: string[],
    private label: string = "t",
  ) {
    this.widths[0] = tokens[0]!.length;
  }
  head(): string {
    return `${this.label}:${this.tokens[0]}`;
  }
  describe(): string {
    return `${this.first} ${this.widths.length} ${this.widths[0]}`;
  }
}

class Base {
  protected log: string[] = [];
  constructor(protected prefix: string) {
    this.log.push(`base ${prefix}`);
  }
}

class Derived extends Base {
  private size = this.items.length + this.prefix.length;
  private echo = this.note("field");
  constructor(
    private items: number[],
    prefix: string,
  ) {
    super(prefix);
    this.log.push(`derived ${this.size}`);
  }
  note(what: string): string {
    this.log.push(`${what} ${this.items.join("+")}`);
    return what;
  }
  report(): string {
    return `${this.log.join("; ")}; ${this.echo}`;
  }
}

console.log(new Tokens(["alpha", "be"]).describe());
console.log(new Tokens(["x"], "L").describe());
console.log(new Derived([1, 2, 3], "pp").report());
