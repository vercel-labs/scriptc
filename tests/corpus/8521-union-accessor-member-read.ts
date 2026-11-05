// A member the arms answer through an ACCESSOR — an inherited getter, or a
// getter a subclass overrides — has no field slot to read, so the read
// dispatches on the union's tag and calls the arm's own getter, once per
// read, as Node does. A data-field arm beside a getter arm reads its slot.
const logs: string[] = [];
class Panel {
  items: string[];
  constructor(items: string[]) {
    this.items = items;
  }
  get hasOverlayEntries(): boolean {
    logs.push("has");
    return this.items.length > 0;
  }
  get count(): number {
    logs.push("count");
    return this.items.length;
  }
}
class MainPanel extends Panel {
  mode = "main";
}
class AltPanel extends Panel {
  mode = "alt";
  get count(): number {
    logs.push("alt count");
    return this.items.length * 10;
  }
}
class FixedPanel {
  mode = "fixed";
  items: string[];
  hasOverlayEntries = true;
  constructor(items: string[]) {
    this.items = items;
  }
  get count(): number {
    logs.push("fixed count");
    return this.items.length + 100;
  }
}

function pickPanel(which: "m" | "a", items: string[]): MainPanel | AltPanel {
  return which === "m" ? new MainPanel(items) : new AltPanel(items);
}
for (const which of ["m", "a"] as const) {
  const panel = pickPanel(which, which === "m" ? ["x"] : []);
  console.log("panel", which, panel.mode, panel.hasOverlayEntries, panel.count);
}

function pickMixed(which: "a" | "f", items: string[]): AltPanel | FixedPanel {
  return which === "a" ? new AltPanel(items) : new FixedPanel(items);
}
for (const which of ["a", "f"] as const) {
  const panel = pickMixed(which, ["y", "z"]);
  console.log("mixed", which, panel.mode, panel.hasOverlayEntries, panel.count);
}
console.log("logs", logs.join(","));
