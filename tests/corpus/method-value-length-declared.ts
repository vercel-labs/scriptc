// A method value's `length` is the length of the method its object's class
// declares, whatever type the receiver is read through. An override may
// declare more parameters than the method it overrides, and a parameter with
// a default ends the count; neither is the parameter count of the slot the
// class inherits.

class Tariff {
  price(units: number): number {
    return units * 2;
  }
  arity(): number {
    return this.price.length;
  }
  rounded(units: number, step = 5): number {
    return Math.round((units * 2) / step) * step;
  }
}

class SeasonalTariff extends Tariff {
  price(units: number, discount?: number): number {
    return units * 2 - (discount ?? 0);
  }
}

class NightTariff extends SeasonalTariff {
  price(units: number, discount?: number, surcharge?: number): number {
    return units * 2 - (discount ?? 0) + (surcharge ?? 0);
  }
}

interface Priced {
  price(units: number): number;
}

function slotLength(price: (units: number) => number): number {
  return price.length;
}

const tariffs: Tariff[] = [new Tariff(), new SeasonalTariff(), new NightTariff()];

// Through the base class, per object.
console.log(tariffs.map((tariff) => tariff.price.length).join(","));

// Through `this` in a method of the base class.
console.log(tariffs.map((tariff) => tariff.arity()).join(","));

// Through an intermediate class, an assertion, an interface and its own class.
const seasonal: SeasonalTariff = new NightTariff();
const priced: Priced = new SeasonalTariff();
const night = new NightTariff();
console.log(
  seasonal.price.length,
  (night as Tariff).price.length,
  priced.price.length,
  night.price.length,
);

// Through a new expression, the class's prototype and a call's result.
function pick(late: boolean): Tariff {
  return late ? new NightTariff() : new Tariff();
}
console.log(
  new NightTariff().price.length,
  NightTariff.prototype.price.length,
  SeasonalTariff.prototype.price.length,
  Tariff.prototype.price.length,
  Tariff.prototype.rounded.length,
  pick(true).price.length,
  pick(false).price.length,
);

// A held value keeps its length, its identity and its receiver.
const base: Tariff = new SeasonalTariff();
const held = base.price;
console.log(held.length, held === base.price, held.call(base, 10), base.price(10));

// Into a function slot, and bound.
console.log(slotLength(base.price), slotLength(new Tariff().price), base.price.bind(base).length);

// A default ends the count; an optional parameter is counted.
const plain = new Tariff();
const rounded = plain.rounded;
console.log(plain.rounded.length, rounded.length, plain.rounded(7), plain.price.length);
