// Short-circuit assignment through a string-keyed index-signature record
// (`timings[phase] ??= value`): a missing key takes the right side, a
// present one keeps its value, and `||=` and `&&=` test truthiness.
class Telemetry {
  private readonly timings: Record<string, number> = {};
  private readonly labels: { [key: string]: string } = {};
  mark(phase: string, at: number): number {
    return (this.timings[phase] ??= at);
  }
  label(key: string, value: string): string {
    this.labels[key] ||= value;
    this.labels[key] &&= this.labels[key].toUpperCase();
    return this.labels[key];
  }
  dump(): string {
    return JSON.stringify(this.timings) + " " + JSON.stringify(this.labels);
  }
}

const t = new Telemetry();
console.log(t.mark("dns", 5), t.mark("tcp", 7), t.mark("dns", 9));
console.log(t.label("a", "first"), t.label("a", "second"), t.label("", "empty"));
console.log(t.dump());

const counts: Record<string, number> = { zero: 0 };
const keys = ["zero", "one", "zero"];
for (const k of keys) counts[k] ??= 10;
for (const k of keys) counts[k] ||= 20;
console.log(JSON.stringify(counts));
