// An override that declares fewer parameters than the method it overrides: the slot drops the
// arguments past its last parameter (they are still evaluated at the call). Through the override's
// class, its base class, an interface, `super`, an untyped value and a stored base reference; with
// a narrowed first parameter, an async override, and a subclass that declares a parameter again.
class Courier {
  trips = 1;
  deliver(parcel: string, floor: number): string {
    return `courier ${parcel} ${floor} ${this.trips}`;
  }
  weigh(load: string | number, crates: string[], fragile?: boolean): string {
    return `courier ${String(load)} ${crates.length} ${String(fragile)}`;
  }
  async route(city: string, stops: number): Promise<string> {
    return `courier ${city} ${stops}`;
  }
  note(text?: string, lines?: number): string {
    return `courier ${text ?? "-"} ${lines ?? 0}`;
  }
}
class Drone extends Courier {
  deliver(): string {
    return `drone ${this.trips}`;
  }
  weigh(load: string): string {
    return `drone ${load.toUpperCase()}`;
  }
  async route(city: string): Promise<string> {
    await Promise.resolve();
    return `drone ${city}`;
  }
  note(): string {
    return "drone";
  }
}
class Swarm extends Drone {
  viaSuper(): string {
    return `swarm ${super.deliver()}`;
  }
  note(text?: string): string {
    return `swarm ${text ?? "none"}`;
  }
}
interface Carrier {
  deliver(parcel: string, floor: number): string;
}
let evaluated = 0;
function next(): number {
  return ++evaluated;
}
const drone = new Drone();
const asCourier: Courier = drone;
const asCarrier: Carrier = drone;
const untyped: any = drone;
console.log(drone.deliver(), asCourier.deliver("x", next()), asCarrier.deliver("y", next()));
console.log(new Swarm().viaSuper(), untyped.deliver("z", next()), drone.deliver.length);
const storedCourier: (parcel: string, floor: number) => string = asCourier.deliver.bind(asCourier);
console.log(storedCourier("w", next()), new Courier().deliver("v", next()), evaluated);
const all: Courier[] = [new Courier(), drone, new Swarm()];
console.log(all.map((each) => each.deliver("a", 1)).join(" | "));
console.log(drone.weigh("a"), asCourier.weigh("b", ["x"], true), untyped.weigh("c", [], false));
console.log(new Courier().weigh(2, ["p", "q"]));
console.log(await drone.route("k"), await asCourier.route("l", 3), await new Courier().route("m", 4));
const drones: Drone[] = [new Drone(), new Swarm()];
console.log(drones.map((each) => each.note()).join(","), all.map((each) => each.note("n", 2)).join(","));
console.log(all.map((each) => each.note()).join(","), new Swarm().note("d"));
