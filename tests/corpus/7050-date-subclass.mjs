// A class that extends Date: private fields beside the time value, super()
// with each Date constructor form, an overriding toISOString that
// JSON.stringify reaches through Date.prototype.toJSON, and the inherited
// Date methods.
class Moment extends Date {
  #zone = "Z";
  #precise = true;
  constructor(value, zone) {
    if (value === undefined) super(0);
    else super(value);
    if (zone !== undefined) this.#zone = zone;
  }
  get zone() {
    return this.#zone;
  }
  coarse() {
    this.#precise = false;
    return this;
  }
  toISOString() {
    const iso = super.toISOString();
    const base = this.#precise ? iso : iso.slice(0, 19) + "Z";
    return this.#zone === "Z" ? base : base.slice(0, -1) + this.#zone;
  }
}

const fromString = new Moment("2001-02-03T04:05:06.789Z");
const fromNumber = new Moment(86400000, "+01:00");
const fromDate = new Moment(new Date(Date.UTC(1999, 11, 31, 23, 59, 59)));
const fromMoment = new Moment(fromString);
const none = new Moment();
console.log(fromString.toISOString(), fromNumber.toISOString(), fromDate.toISOString());
console.log(fromMoment.getTime() === fromString.getTime(), none.getTime(), fromNumber.zone);
console.log(fromString.getUTCFullYear(), fromString.getUTCMonth(), fromString.getUTCDate(), fromString.getUTCHours(), fromString.getUTCMilliseconds());
console.log(fromString instanceof Date, fromString instanceof Moment, new Date(0) instanceof Moment);
console.log(JSON.stringify({ fromString, fromNumber, list: [fromDate.coarse()] }));
console.log(fromNumber.toJSON(), JSON.stringify(fromNumber));
console.log(String(fromDate).slice(0, 15), `${fromDate}`.slice(0, 15), fromDate.toUTCString());
console.log(+fromNumber, +fromNumber - 1000, fromNumber.valueOf(), fromNumber + "" === String(fromNumber));
console.log(fromString > fromNumber, fromString < fromNumber, fromString >= fromMoment);
console.log(fromNumber.setTime(1000), fromNumber.getTime(), fromNumber.toISOString());
console.log(new Date(fromString).toISOString(), new Date(fromNumber).getTime());
console.log(fromString, [fromNumber], { d: fromDate });

const invalid = new Moment("not a date");
console.log(Number.isNaN(invalid.getTime()), JSON.stringify({ invalid }), invalid.toJSON(), String(invalid));
console.log(invalid);
try {
  invalid.toISOString();
} catch (error) {
  console.log(error instanceof RangeError, error.message);
}

class LocalMoment extends Moment {
  constructor(value) {
    super(value, "local");
  }
  toISOString() {
    return super.toISOString().replace("local", "");
  }
}
const local = new LocalMoment(0);
console.log(local.toISOString(), JSON.stringify([local]), local instanceof Moment, local.zone);

// The field constructor and Date's statics, which the subclass inherits.
class Plain extends Date {}
const fields = new Plain(2020, 0, 15, 10, 30);
console.log(fields.getFullYear(), fields.getMonth(), fields.getDate(), fields.getHours(), fields.getMinutes());
console.log(Plain.UTC(2000, 0, 1), Plain.parse("2000-01-01T00:00:00Z"), typeof Plain.now(), Object.keys(fields));

// Date held as a value answers instanceof for subclass instances.
const constructors = { date: Date };
console.log(fields instanceof constructors.date, local instanceof constructors.date, {} instanceof constructors.date);

// setTime evaluates every argument before it converts the first one.
let base = 1000;
const delayed = { valueOf: () => base };
console.log(fields.setTime(delayed, (base = 2000)), fields.getTime());
