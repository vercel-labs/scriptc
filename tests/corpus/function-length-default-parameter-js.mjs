// A JavaScript function's `length` counts the parameters before the first
// one with a default or a rest: declarations, expressions, arrows, object
// and class methods, async and generator functions, read directly, held,
// passed and bound.

function sow(seed, depth = 2) {
  return `${seed}@${depth}`;
}

function water(litres = 1, rows) {
  return `${litres}/${rows}`;
}

function prune(branch, angle = 45, seal) {
  return `${branch}:${angle}:${seal}`;
}

function stake({ height } = { height: 1 }, ties) {
  return `${height}:${ties}`;
}

function rake(bed, ...passes) {
  return bed + passes.length;
}

function plain(bed, row) {
  return bed + row;
}

const mulch = function (bed, layers = 1) {
  return bed * layers;
};

const thin = (row, keep = 3, gap = 1) => row + keep + gap;

const shed = {
  stack(pots, high = 4) {
    return pots * high;
  },
};

class Plot {
  static mark(corner, flags = 4) {
    return `${corner}:${flags}`;
  }
  till(rows, deep = false) {
    return `${rows}:${deep}`;
  }
}

async function ripen(fruit, days = 7) {
  return `${fruit}:${days}`;
}

function* harvest(crates, each = 1) {
  for (let left = crates; left > 0; left -= each) yield left;
}

function size(fn) {
  return fn.length;
}

console.log(sow.length, water.length, prune.length, stake.length, rake.length, plain.length);
console.log(mulch.length, thin.length, shed.stack.length, Plot.mark.length, new Plot().till.length);
console.log(ripen.length, harvest.length);

const held = sow;
const heldMethod = new Plot().till;
const list = [water, prune];
console.log(held.length, heldMethod.length, list[0].length, list[1].length);
console.log(size(sow), size(mulch), size(thin), size(shed.stack), size(Plot.mark), size(ripen));
console.log(sow.bind(null).length, prune.bind(null, "oak").length, thin.bind(null).length);

console.log(sow("pea"), sow("pea", 5), water(), water(2, 3), prune("oak"), stake(), stake({ height: 2 }, 3));
console.log(rake(1), rake(1, 2, 3), plain(1, 2), mulch(3), mulch(3, 2), thin(1), thin(1, 2, 3));
console.log(shed.stack(2), Plot.mark("ne"), new Plot().till(4), [...harvest(3)], [...harvest(4, 2)]);
ripen("fig").then((first) => ripen("fig", 2).then((second) => console.log(first, second)));
