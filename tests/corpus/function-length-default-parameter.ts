// A function's `length` counts the parameters before the first one with a
// default or a rest, whatever kind of function it is and however the value
// is read: directly, held in a binding, through an untyped value, as an
// array element, after `bind`. A parameter that is only optional counts.

function brew(grams: number, minutes = 4): string {
  return `${grams}g for ${minutes}min`;
}

function steep(minutes = 3, grams?: number): string {
  return `${grams ?? 0}g for ${minutes}min`;
}

function blend(base: string, ratio = 0.5, extra?: string): string {
  return `${base}:${ratio}:${extra ?? "-"}`;
}

function pour({ cups }: { cups: number } = { cups: 1 }, saucer?: boolean): number {
  return saucer ? cups * 2 : cups;
}

function rinse(pot: string, times?: number): string {
  return pot.repeat(times ?? 1);
}

function plain(pot: string, cups: number): string {
  return `${pot}${cups}`;
}

const strain = function (leaves: string, mesh = 2): string {
  return leaves.slice(mesh);
};

const chill = (litres: number, ice = 1, mint = 0): number => litres + ice + mint;

const kettle = {
  boil(litres: number, target = 100): number {
    return litres * target;
  },
  hold(litres: number, target: number): number {
    return litres + target;
  },
};

class Teapot {
  static warm(pot: string, seconds = 30): string {
    return `${pot}:${seconds}`;
  }
  static #glaze(coats = 2, colour?: string): string {
    return `${coats}:${colour ?? "clear"}`;
  }
  static glazeLength(): number {
    return Teapot.#glaze.length;
  }
  static glazed(): string {
    return Teapot.#glaze();
  }
  fill(litres: number, leaves = "green"): string {
    return `${litres}:${leaves}`;
  }
}

async function infuse(leaves: string, seconds = 90): Promise<string> {
  return `${leaves}:${seconds}`;
}

function* sips(cup: number, each = 1): Generator<number> {
  for (let left = cup; left > 0; left -= each) yield left;
}

function tray(rows: number) {
  return function (cups: number, spare = rows): number {
    return cups * rows + spare;
  };
}

function size(fn: any): number {
  return fn.length;
}

// Read directly.
console.log(brew.length, steep.length, blend.length, pour.length, rinse.length, plain.length);
console.log(strain.length, chill.length, kettle.boil.length, kettle.hold.length);
console.log(Teapot.warm.length, Teapot.glazeLength(), new Teapot().fill.length);
console.log(infuse.length, sips.length, tray(3).length);

// Held, untyped, as an element, bound, passed.
const held = brew;
const loose: any = blend;
const shelf = [steep, steep];
const heldStatic = Teapot.warm;
console.log(held.length, loose.length, shelf[0]!.length, heldStatic.length);
console.log(brew.bind(null).length, blend.bind(null, "assam").length, chill.bind(null).length);
console.log(size(brew), size(strain), size(chill), size(kettle.boil), size(Teapot.warm), size(tray(2)));
console.log(size(plain), size(rinse), size(kettle.hold));

// The functions still take their defaults.
console.log(brew(12), brew(12, 6), steep(), steep(5, 9), blend("assam"), blend("assam", 0.25, "milk"));
console.log(pour(), pour({ cups: 3 }, true), rinse("ab"), rinse("ab", 2), plain("p", 2));
console.log(strain("leaves"), strain("leaves", 4), chill(1), chill(1, 2, 3));
console.log(kettle.boil(2), kettle.boil(2, 80), kettle.hold(1, 2));
console.log(Teapot.warm("clay"), Teapot.warm("clay", 5), Teapot.glazed(), new Teapot().fill(1), held(3));
console.log([...sips(3)], [...sips(4, 2)], tray(3)(2), tray(3)(2, 1));
infuse("oolong").then((first) => infuse("oolong", 30).then((second) => console.log(first, second)));

// The same function is one value however it is mentioned.
console.log(held === brew, shelf[0] === steep, heldStatic === Teapot.warm);
