// An object of methods written for two records, put in a list of the
// interface instantiated with three. A value built as the third record
// converts when its properties say which of the two records it is. Here they
// cannot: one record requires `depth` and the other declares it optional, so
// the copy into the first is a checked extraction that throws for a value
// without `depth`, which the second record holds. Records that keep a
// property at different types are not told apart by which properties a value
// has, and the list entry stays refused.
interface Bulb {
  depth: number;
  ring?: string;
}
interface Seed {
  depth?: number;
  row?: string;
}
interface Cutting {
  depth?: number;
  ring?: string;
  row?: string;
  rooted?: boolean;
}
type Plant = Bulb | Seed | Cutting;

interface Plot<P> {
  bed: string;
  plant?: P;
}
interface Gardener<P> {
  sow(plot: Plot<P>): string;
}

const bulbsAndSeeds: Gardener<Bulb | Seed> = {
  sow(plot) {
    const plant = plot.plant;
    if (plant === undefined) return `${plot.bed}: fallow`;
    return `${plot.bed}: depth ${plant.depth} ${"ring" in plant ? "ringed" : "loose"} ${JSON.stringify(plant)}`;
  },
};

function cutting(bed: string, plant?: Cutting): Plot<Plant> {
  return { bed, plant };
}

const crew: Gardener<Plant>[] = [bulbsAndSeeds];
const tulip: Bulb = { depth: 15, ring: "outer" };
const cress: Seed = { row: "third" };
const plots: Plot<Plant>[] = [
  { bed: "north", plant: tulip },
  { bed: "south", plant: cress },
  cutting("east", { depth: 6, ring: "inner" }),
  cutting("west", { row: "first" }),
  cutting("yard", { rooted: true }),
  cutting("path"),
];
for (const plot of plots) console.log(crew[0]!.sow(plot));
