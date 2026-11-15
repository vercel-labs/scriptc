// The index signature of a source record can satisfy a target member while
// the source also declares a member narrower than the signature's value:
// the projection of the signature-fed member reads only that key.

interface Wide {
  kind: string;
}
interface Narrow {
  kind: string;
  rank: number;
}

type Source = { narrow: Narrow } & Record<string, Wide>;

interface Target {
  narrow: Narrow;
  other?: Wide;
}

function describe(target: Target): string {
  return target.other === undefined
    ? `${target.narrow.kind}:none`
    : `${target.narrow.kind}:${target.other.kind}`;
}

function read(source: Source): string {
  return describe(source);
}

const narrow: Narrow = { kind: "a", rank: 1 };
const source: Source = { narrow, other: { kind: "b" } };
console.log(read(source));

const withoutOther: Source = { narrow };
console.log(read(withoutOther));
