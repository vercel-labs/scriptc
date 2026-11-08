// An object of methods written for two records, put in a list of the
// interface instantiated with three through an assertion. The two records
// give the shared member `mark` different types, so which properties a value
// has cannot say which record it is: the member's value does. The asserted
// entry is checked value by value when the method is called, and each value
// is read as the record its `mark` fits.
interface Dial {
  mark?: number;
  glass?: boolean;
}
interface Strip {
  mark?: string;
  paper?: string;
}
interface Probe {
  mark?: number | string;
  wired?: boolean;
}
type Meter = Dial | Strip | Probe;

interface Slot<M> {
  bay: string;
  meter?: M;
}
interface Reader<M> {
  read(slot: Slot<M>): string;
}

const dialsAndStrips: Reader<Dial | Strip> = {
  read(slot) {
    const meter = slot.meter;
    return meter === undefined ? `${slot.bay} empty` : `${slot.bay} ${typeof meter.mark} ${JSON.stringify(meter)}`;
  },
};

function probe(bay: string, meter?: Probe): Slot<Meter> {
  return { bay, meter };
}

const readers: Reader<Meter>[] = [dialsAndStrips as Reader<Meter>];
const dial: Dial = { mark: 40, glass: true };
const strip: Strip = { mark: "blue", paper: "litmus" };
const slots: Slot<Meter>[] = [
  probe("b1", { mark: "red" }),
  probe("b2", { mark: 12 }),
  { bay: "b3", meter: strip },
  { bay: "b4", meter: dial },
  probe("b5", { wired: false }),
  probe("b6"),
  probe("b7", {}),
];
for (const slot of slots) console.log(readers[0]!.read(slot));
