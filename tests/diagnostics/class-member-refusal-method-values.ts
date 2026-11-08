// A method read as a value through a base-typed receiver answers the
// function of the receiver's own class, so the read selects among the
// classes below the base. A class that refused the member has no function
// to select: the read is an error that names the member, as a typed use of
// it is, and the member's own diagnostic is reported once.

// an override the inherited slot cannot carry, read through an element of
// a base-typed array
class Vehicle {
  honk(times: number, tone: string): string {
    return tone.repeat(times);
  }
}
class Bicycle extends Vehicle {
  honk(): string {
    return `ring ${arguments.length}`;
  }
}
const garage: Vehicle[] = [new Vehicle(), new Bicycle()];
const horn = garage[1]!.honk;
console.log(horn.name);

// a typed call of the refused override beside a read through the base
class Parcel {
  label(to: string, grams: number): string {
    return `${to} ${grams}g`;
  }
}
class Envelope extends Parcel {
  label(): string {
    return `flat ${arguments.length}`;
  }
}
const post: Parcel[] = [new Parcel(), new Envelope()];
console.log(new Envelope().label());
const stamp = post[0]!.label;
console.log(stamp.name, stamp.call(post[0]!, "north", 20));

// a class below the refused override overrides it again with a signature
// the slot cannot carry either, a typed call reaches the first through a
// binding of its class, and the base reads the method through `this`: the
// read names each class that refused the member
class Instrument {
  play(note: string, beats: number): string {
    return `${note}/${beats}`;
  }
  title(): string {
    const own = this.play;
    return own.name;
  }
}
class Drum extends Instrument {
  play(): string {
    return `hit ${arguments.length}`;
  }
}
class Kit extends Drum {
  play(note: string = "rest", beats?: number): string {
    return `kit ${note}/${beats}`;
  }
}
const band: Instrument[] = [new Instrument(), new Drum(), new Kit()];
const seated: Drum = new Kit();
console.log(seated.play());
console.log(band.map((member) => member.title()).join());

// an override whose signature has no mapping
class Sensor {
  watch(target: object): number {
    return target === null ? 0 : 1;
  }
}
class Shy extends Sensor {
  watch(target: WeakRef<object>): number {
    return target.deref() === undefined ? 0 : 1;
  }
}
const sensors: Sensor[] = [new Sensor(), new Shy()];
const probe = sensors[1]!.watch;
console.log(probe.name);
