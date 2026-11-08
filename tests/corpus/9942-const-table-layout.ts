// A table written `as const` has its own type, the literal's. Read through
// one interface it is still the one object Node sees: a Map keyed by the
// plant finds it however it arrived (by its binding, as a companion of
// another plant, out of a list), `===` holds, and an array search finds it.
interface Plant {
  readonly name: string;
  readonly sun?: "full" | "half";
  readonly height?: number;
  readonly companions?: ReadonlyArray<Plant>;
}

const basil = { name: "basil", sun: "full" } as const;
const marigold = { height: 30, name: "marigold" } as const;
const tomato = {
  name: "tomato",
  sun: "full",
  height: 180,
  companions: [basil, marigold, { name: "chive" }],
} as const;
const fern = { name: "fern", sun: "half" } as const;

// The bed each plant went into, by the plant itself.
const planted = new Map<Plant, number>();
function plant(what: Plant, bed: number): void {
  if (!planted.has(what)) planted.set(what, bed);
  for (const companion of what.companions ?? []) plant(companion, bed);
}
function bedOf(what: Plant): number {
  return planted.get(what) ?? 0;
}

plant(tomato, 1);
plant(fern, 2);
plant(basil, 3);
console.log(bedOf(tomato), bedOf(basil), bedOf(marigold), bedOf(fern), planted.size);

// Members read through the table's own type, where the interface makes
// some of them optional.
console.log(tomato.name, tomato.height + 20, basil.sun, marigold.height / 2, `${fern.name}:${fern.sun}`);
console.log(Object.keys(marigold), JSON.stringify(tomato));
console.log("sun" in marigold, "height" in marigold, Object.keys(fern).length);

// The same plant through a list, an annotated binding and an assertion.
const shed: Plant[] = [tomato, fern];
const first: Plant = tomato;
const again = tomato as Plant;
console.log(shed[0] === first, again === first, first === tomato, shed.indexOf(fern), shed.includes(basil));
console.log(first.companions?.[0] === basil, first.companions === again.companions, first.companions?.length);

const seen = new Set<Plant>(shed);
seen.add(tomato);
seen.add(first.companions![1]!);
console.log(seen.size, seen.has(marigold), seen.has(basil), seen.has(fern));

function taller<Kind extends Plant>(left: Kind, right: Kind): Plant {
  return (left.height ?? 0) >= (right.height ?? 0) ? left : right;
}
console.log(taller(tomato, tomato) === tomato, taller(fern, fern).name);

function label(what: Plant): string {
  switch (what) {
    case tomato:
      return "the tomato";
    case fern:
      return "the fern";
    default:
      return `some ${what.name}`;
  }
}
console.log(label(first), label(shed[1]!), label(first.companions![2]!), label(basil));

// A table handed to code that takes any value is the same object there.
function same(left: unknown, right: unknown): boolean {
  return left === right;
}
console.log(same(first, tomato), same(first.companions?.[1], marigold), same(fern, tomato));
