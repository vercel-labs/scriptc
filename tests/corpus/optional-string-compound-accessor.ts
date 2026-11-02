// `+=` on an optional-string accessor reads it once, whatever the right
// operand's type: the getter's side effects happen a single time, and the
// value it returned is the one the append uses. A dynamic right operand
// converts the absent arm to its ToString, as JavaScript's `+` does.
class Banner {
  stored: string | undefined = undefined;
  reads = 0;
  get label(): string | undefined {
    this.reads += 1;
    return this.reads === 1 ? "first" : "second";
  }
  set label(value: string | undefined) {
    this.stored = value;
  }
}

const banner = new Banner();
const suffix: any = JSON.parse('"!"');
banner.label += suffix;
console.log("dynamic", banner.reads, banner.stored);

const typed = new Banner();
typed.label += "?";
console.log("typed", typed.reads, typed.stored);

class Empty {
  stored: string | undefined = undefined;
  reads = 0;
  get label(): string | undefined {
    this.reads += 1;
    return undefined;
  }
  set label(value: string | undefined) {
    this.stored = value;
  }
}

const empty = new Empty();
const question: any = JSON.parse('"?"');
empty.label += question;
console.log("absent", empty.reads, empty.stored);
