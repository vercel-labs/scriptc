// A class that extends a generic class, handed to a library as `unknown`.
// JavaScript has one class object and one prototype per declaration, however
// many instantiations the types name: the statics, `prototype` and its
// members, construction, `instanceof` and the prototype chain read through
// the dynamic value answer as in Node.

const brand: object = {};

class Instrument<Tuning> {
  static section: string = 'orchestra';
  static seats: {rows: number} = {rows: 4};
  static describeSection(): string {
    return 'section ' + Instrument.section;
  }
  tuning: Tuning;
  name: string;
  constructor(tuning: Tuning) {
    this.tuning = tuning;
    this.name = 'instrument';
  }
  get isInstrument(): object {
    return brand;
  }
  describe(): string {
    return this.name + ' ' + JSON.stringify(this.tuning);
  }
  play(): string {
    return 'silence from ' + this.name;
  }
}

class Bowed<Tuning> extends Instrument<Tuning> {
  static bow: string = 'horsehair';
  get isBowed(): boolean {
    return true;
  }
  rosin(): string {
    return 'rosin on ' + this.name;
  }
}

class Violin extends Bowed<{strings: number}> {
  static defaults: {strings: number} = {strings: 4};
  static family: string = 'strings';
  pitch: number;
  constructor(tuning: {strings: number}) {
    super(tuning);
    this.name = 'violin';
    this.pitch = tuning.strings * 110;
  }
  play(): string {
    return 'violin at ' + this.pitch + ', ' + this.describe();
  }
}

class Drum extends Instrument<{skins: string}> {
  constructor(tuning: {skins: string}) {
    super(tuning);
    this.name = 'drum';
  }
  play(): string {
    return 'boom, ' + this.describe();
  }
}

class Metronome {
  beats: number = 60;
  play(): string {
    return 'tick ' + this.beats;
  }
}

function isRecord(value: unknown): value is {[key: string]: unknown} {
  return typeof value === 'object' && value !== null;
}
type ClassLike = {
  new (...args: unknown[]): {[key: string]: unknown};
  readonly [key: string]: unknown;
};
function isClassLike(value: unknown): value is ClassLike {
  return typeof value === 'function';
}

// The host: classes held as unknown, told apart by a marker on `prototype`,
// constructed with their defaults and played through a dictionary.
const stage = new Map<string, unknown>();
stage.set('violin', Violin);
stage.set('drum', Drum);
stage.set('metronome', Metronome);
stage.set('noise', (): string => 'hiss');
stage.set('label', 'not a class');

function perform(key: string): string {
  const type: unknown = stage.get(key);
  if (!isClassLike(type)) return key + ': not a class';
  const prototype = type.prototype;
  if (!isRecord(prototype) || !prototype['isInstrument']) return key + ': no instrument';
  const defaults = type.defaults;
  const made = new type(isRecord(defaults) ? defaults : {skins: 'calf'});
  const play = made['play'];
  return key + ': ' + (typeof play === 'function' ? String(play.call(made)) : 'cannot play');
}
for (const key of ['violin', 'drum', 'metronome', 'noise', 'label']) console.log(perform(key));

function inspect(label: string, type: unknown): void {
  if (!isClassLike(type)) return;
  console.log(label, 'statics', String(type['family']), String(type['section']), String(type['bow']), String(type['missing']));
  console.log(label, 'own keys', Object.keys(type).join(','), '|', Object.hasOwn(type, 'section'), 'section' in type);
  const seats = type['seats'];
  console.log(label, 'seats', isRecord(seats) ? seats['rows'] : 'none');
  const describeSection = type['describeSection'];
  console.log(label, 'static call', typeof describeSection === 'function' ? describeSection.call(type) : 'none');
  const prototype = type.prototype;
  if (isRecord(prototype)) {
    console.log(label, 'prototype', Object.getOwnPropertyNames(prototype).join(','), prototype['constructor'] === type);
    console.log(label, 'markers', !!prototype['isInstrument'], String(prototype['isBowed']), 'describe' in prototype);
    let depth = 0;
    let names = '';
    for (let at: unknown = prototype; at !== null && depth < 9; at = Object.getPrototypeOf(at)) {
      depth++;
      if (isRecord(at)) names += Object.getOwnPropertyNames(at).length + ' ';
    }
    console.log(label, 'chain', depth, names);
  }
  const parent: unknown = Object.getPrototypeOf(type);
  console.log(label, 'parent', typeof parent, isClassLike(parent) ? parent['name'] : 'none');
}
inspect('violin', Violin);
inspect('drum', Drum);

function prototypeOf(type: unknown): unknown {
  return isClassLike(type) ? type.prototype : undefined;
}

// One class object per declaration: the parents of two classes that extend
// different instantiations are the same value, to `===` and as a key.
const violinClass: unknown = Violin;
const drumClass: unknown = Drum;
if (isClassLike(violinClass) && isClassLike(drumClass)) {
  const bowed: unknown = Object.getPrototypeOf(violinClass);
  const above: unknown = Object.getPrototypeOf(bowed);
  const drumParent: unknown = Object.getPrototypeOf(drumClass);
  console.log('one class', above === drumParent, bowed === drumParent, violinClass === drumClass);
  const seen = new Map<unknown, string>();
  seen.set(above, 'instrument');
  console.log('as a key', String(seen.get(drumParent)), seen.has(bowed), seen.size);
  const violinPrototype = prototypeOf(violinClass);
  const drumPrototype = prototypeOf(drumClass);
  console.log(
    'one prototype',
    Object.getPrototypeOf(Object.getPrototypeOf(violinPrototype)) === Object.getPrototypeOf(drumPrototype),
  );
}

// Instances through the dynamic value: the chain, the constructor, a method
// of the generic class called through its prototype on each instantiation.
const violin = new Violin({strings: 5});
const drum = new Drum({skins: 'goat'});
function examine(label: string, value: unknown, type: unknown): void {
  if (!isRecord(value) || !isClassLike(type)) return;
  const first: unknown = Object.getPrototypeOf(value);
  console.log(label, 'instance', first === type.prototype, value['constructor'] === type, value instanceof Instrument);
  console.log(label, 'marker', value['isInstrument'] === brand, String(value['isBowed']));
  for (let at: unknown = first; isRecord(at); at = Object.getPrototypeOf(at)) {
    if (!Object.hasOwn(at, 'describe')) continue;
    const describe = at['describe'];
    const play = at['play'];
    console.log(label, 'declared', typeof describe === 'function' ? describe.call(value) : 'none');
    console.log(label, 'not overridden', typeof play === 'function' ? play.call(value) : 'none');
    break;
  }
}
examine('violin', violin, Violin);
examine('drum', drum, Drum);
