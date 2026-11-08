// Promise.all over an optional entry whose promise's value cannot be
// undefined: the position would hold the value from one side and undefined
// from the other. (A value type that includes undefined compiles:
// tests/corpus/promise-all-optional-value-entries.ts.)
class Conn {
  name = "c";
}
class Pool {
  primary: Promise<Conn> | undefined;
  async names(extra: Promise<string>): Promise<string> {
    const [conn, label] = await Promise.all([this.primary, extra]);
    return `${conn?.name}:${label}`;
  }
}
new Pool().names(Promise.resolve("x")).then((s) => console.log(s));
