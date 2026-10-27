// Fields without initializers that a method reads while the constructor
// has not assigned them yet (the constructor calls the method first).
// Node reads undefined there, so member access on it throws a TypeError;
// after the assignment the same reads see the values.

class Settings {
  internal: { n: number };
  items: number[];
  label: string;

  constructor() {
    console.log(this.describe());
    this.internal = { n: 1 };
    this.items = [1, 2];
    this.label = "ready";
    console.log(this.describe());
  }

  describe(): string {
    let internal: string;
    let items: string;
    let label: string;
    try {
      internal = String(this.internal.n);
    } catch (e) {
      internal = e instanceof TypeError ? "TypeError" : "other";
    }
    try {
      items = String(this.items.length);
    } catch (e) {
      items = e instanceof TypeError ? "TypeError" : "other";
    }
    try {
      label = this.label.toUpperCase();
    } catch (e) {
      label = e instanceof TypeError ? "TypeError" : "other";
    }
    return `${internal} ${items} ${label}`;
  }
}

const settings = new Settings();
settings.items.push(3);
console.log(settings.internal.n, settings.items.length, settings.label);
