// A class that extends Array whose constructor's length parameter is
// optional or has a default takes the species length argument: map,
// filter and slice construct their results through it.
class Optional extends Array<number> {
  constructor(length?: number) {
    super(length ?? 0);
  }
}

class Defaulted extends Array<string> {
  tag: string;
  constructor(length = 0, tag = "none") {
    super(length);
    this.tag = tag;
  }
}

const optional = Optional.from([1, 2, 3]);
const mapped = optional.map((value) => value * 10);
console.log(mapped instanceof Optional, mapped.join(","), optional.slice(1) instanceof Optional);
console.log(optional.filter((value) => value !== 2).join(","));

const defaulted = new Defaulted(2).fill("x");
const sliced = defaulted.slice(0, 1);
if (sliced instanceof Defaulted) console.log(sliced.length, sliced.tag);
console.log(defaulted.map((s) => s + "!").join(","));
