// A listener that reads the owner of its emitter closes a cycle: owner ->
// emitter -> listener -> owner. Here the emitter is a program subclass of
// EventEmitter, one and two levels down, and the owner holds it in a record
// member, a nullable member, an optional member, a class member, an array,
// a Map, and a record inside a record. Each owner is dropped with the
// listener still registered (after the event fired, or never fired) or with
// the listener removed first. The cycle collector has to trace every such
// owner: the reference-count audit of the sanitized lane fails when one is
// left behind, whatever the program prints.
import { EventEmitter } from "node:events";

class Gauge extends EventEmitter {
  readings = 0;
  report(value: number): void {
    this.readings++;
    this.emit("reading", value);
  }
}
class RainGauge extends Gauge {
  unit = "mm";
}

type Station = { name: string; gauge: Gauge; total: number };
type SpareStation = { name: string; gauge: RainGauge | null; total: number };
type LooseStation = { name: string; gauge?: Gauge; total: number };
class Tower {
  gauge: RainGauge;
  spare: Gauge | null = null;
  total = 0;
  constructor(gauge: RainGauge) {
    this.gauge = gauge;
  }
}
type Meadow = { gauges: Gauge[]; total: number };
type Region = { byName: Map<string, RainGauge>; total: number };
type Network = { hub: { gauge: Gauge; hops: number }; total: number };

let grand = 0;
let fired = 0;

function settle(gauge: Gauge, mode: string, round: number): void {
  if (mode === "idle") return;
  gauge.report(round + 1);
  if (mode === "removed") gauge.removeAllListeners("reading");
}

function station(mode: string, round: number): void {
  const gauge = new Gauge();
  const owner: Station = { name: "s" + round, gauge, total: 0 };
  gauge.on("reading", (value: number) => {
    owner.total += value;
    grand += owner.total + owner.gauge.readings;
    fired++;
  });
  settle(gauge, mode, round);
}

function spareStation(mode: string, round: number): void {
  const gauge = new RainGauge();
  const owner: SpareStation = { name: "p" + round, gauge: null, total: 0 };
  owner.gauge = gauge;
  gauge.on("reading", (value: number) => {
    owner.total += value;
    grand += owner.gauge === null ? 0 : owner.gauge.unit.length;
    fired++;
  });
  settle(gauge, mode, round);
}

function looseStation(mode: string, round: number): void {
  const gauge = new Gauge();
  const owner: LooseStation = { name: "l" + round, total: 0 };
  owner.gauge = gauge;
  gauge.on("reading", (value: number) => {
    owner.total += value;
    grand += owner.gauge === undefined ? 0 : owner.name.length;
    fired++;
  });
  settle(gauge, mode, round);
}

function tower(mode: string, round: number): void {
  const gauge = new RainGauge();
  const spare = new Gauge();
  const owner = new Tower(gauge);
  owner.spare = spare;
  gauge.on("reading", (value: number) => {
    owner.total += value;
    grand += owner.total;
    fired++;
  });
  spare.on("reading", (value: number) => {
    owner.total -= value;
    grand += owner.spare === null ? 0 : 1;
    fired++;
  });
  settle(gauge, mode, round);
  settle(spare, mode, round);
}

function meadow(mode: string, round: number): void {
  const first = new Gauge();
  const second = new RainGauge();
  const owner: Meadow = { gauges: [first, second], total: 0 };
  for (const gauge of owner.gauges) {
    gauge.on("reading", (value: number) => {
      owner.total += value;
      grand += owner.gauges.length;
      fired++;
    });
  }
  settle(first, mode, round);
  settle(second, mode, round);
}

function region(mode: string, round: number): void {
  const gauge = new RainGauge();
  const owner: Region = { byName: new Map<string, RainGauge>(), total: 0 };
  owner.byName.set("north", gauge);
  gauge.on("reading", (value: number) => {
    owner.total += value;
    grand += owner.byName.size;
    fired++;
  });
  settle(gauge, mode, round);
}

function network(mode: string, round: number): void {
  const gauge = new Gauge();
  const owner: Network = { hub: { gauge, hops: 2 }, total: 0 };
  gauge.on("reading", (value: number) => {
    owner.total += value;
    grand += owner.hub.hops;
    fired++;
  });
  settle(gauge, mode, round);
}

for (const mode of ["fired", "idle", "removed"]) {
  const before = grand;
  const firedBefore = fired;
  for (let round = 0; round < 40; round++) {
    station(mode, round);
    spareStation(mode, round);
    looseStation(mode, round);
    tower(mode, round);
    meadow(mode, round);
    region(mode, round);
    network(mode, round);
  }
  console.log(mode, "listeners ran", fired - firedBefore, "sum", grand - before);
}
