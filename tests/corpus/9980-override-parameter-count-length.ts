// A method's `length` is that of the function its object's class declares,
// whatever the read goes through. Here the override's own parameter count
// differs from the count of the slot it inherits (one more optional
// parameter, and no parameters at all), beside an inherited method whose
// second parameter has a default.
interface Switchable {
  dim(level: number): string;
  blink(times: number, gap: number): string;
}
class Lamp implements Switchable {
  dim(level: number): string {
    return `lamp ${level}`;
  }
  blink(times: number, gap: number): string {
    return `lamp ${times}x${gap}`;
  }
  tint(hue: string, depth: number = 1): string {
    return `lamp ${hue} ${depth}`;
  }
  counts(): string {
    return `${this.dim.length}${this.blink.length}${this.tint.length}`;
  }
}
class Spot extends Lamp {
  dim(level: number, fade?: number): string {
    return `spot ${level} ${fade ?? 0}`;
  }
}
class Bulb extends Lamp {
  blink(): string {
    return "bulb";
  }
}
class Candle extends Bulb {
  lit = true;
}
const lamps: Lamp[] = [new Lamp(), new Spot(), new Bulb(), new Candle()];
// through the prototypes
console.log(
  Lamp.prototype.dim.length,
  Spot.prototype.dim.length,
  Lamp.prototype.blink.length,
  Bulb.prototype.blink.length,
  Bulb.prototype.tint.length,
  Candle.prototype.blink.length,
);
// through a fresh instance
console.log(new Spot().dim.length, new Bulb().blink.length, new Bulb().tint.length, new Lamp().blink.length);
// through base-typed elements
console.log(
  lamps.map((lamp) => lamp.dim.length).join(),
  lamps.map((lamp) => lamp.blink.length).join(),
  lamps.map((lamp) => lamp.tint.length).join(),
);
// through bindings typed as the class
const spot: Spot = new Spot();
const bulb: Bulb = new Bulb();
const candle: Candle = new Candle();
console.log(spot.dim.length, bulb.blink.length, bulb.tint.length, candle.blink.length, candle.tint.length);
// through `this` in a base method
console.log(lamps.map((lamp) => lamp.counts()).join());
// through an interface and an untyped value
const viewed: Switchable[] = lamps;
const loose: any[] = lamps;
console.log(
  viewed.map((each) => `${each.dim.length}${each.blink.length}`).join(),
  loose.map((each) => `${each.dim.length}${each.blink.length}${each.tint.length}`).join(),
);
// a held value through the base
const held = lamps.map((lamp) => lamp.blink);
console.log(held.map((fn) => fn.length).join());
// the calls still reach the override
console.log(spot.dim(1, 2), bulb.blink(), bulb.tint("warm"), lamps[2]!.blink(3, 4), lamps[1]!.dim(5), lamps[3]!.tint("cold", 2));
