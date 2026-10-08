// Classes with matching members are still distinct classes once compiled:
// asserting or assigning an instance of one as the other cannot succeed.
class Crate {
  label = "crate";
  weight = 4;
}
class Pallet {
  label = "pallet";
  weight = 40;
  slots = 8;
}

function load(): Crate {
  return new Crate();
}

const crate = load();
const pallet = crate as Pallet;
console.log(pallet.slots);

const stored: Crate = new Pallet();
console.log(stored.weight);
