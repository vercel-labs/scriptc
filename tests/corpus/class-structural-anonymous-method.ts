// A class instance stored in a field typed as an anonymous structural object
// type that the class satisfies. Node keeps the instance itself, so calls
// dispatch to the class method (including a subclass override) and `===`
// still holds. The type may be an optional method inside a union with
// undefined (pi's `{ handleInput?(data: string): void } | undefined`), a
// required method in a plain slot, or data only.

class SelectList {
  label = "list";
  hits = 0;
  handleInput(data: string): void {
    this.hits++;
    console.log(`${this.label} handled ${data} (${this.hits})`);
  }
}

class HuggingFaceSearch extends SelectList {
  label = "search";
  handleInput(data: string): void {
    super.handleInput(data);
    console.log("override", data);
  }
}

class Screen {
  private inputHandler: { handleInput?(data: string): void } | undefined;
  setContent(inputHandler?: { handleInput?(data: string): void }): void {
    this.inputHandler = inputHandler;
  }
  forward(data: string): void {
    this.inputHandler?.handleInput?.(data);
  }
  hasHandler(): boolean {
    return this.inputHandler !== undefined;
  }
}

const screen = new Screen();
console.log("empty", screen.hasHandler());
const list = new SelectList();
screen.setContent(list);
screen.forward("a");
console.log("filled", screen.hasHandler());
screen.setContent(new HuggingFaceSearch());
screen.forward("b");
screen.setContent(undefined);
console.log("cleared", screen.hasHandler());
console.log("list hits", list.hits);

// A required method in a plain anonymous slot: the receiver stays the
// original instance.
class Button {
  presses = 0;
  press(): void {
    this.presses++;
    console.log("press", this.presses);
  }
}
function pressTwice(button: { press(): void }): void {
  button.press();
  button.press();
}
const button = new Button();
pressTwice(button);
console.log("button presses", button.presses);

// Identity through the anonymous view holds.
class Holder {
  value: { press(): void } | undefined = undefined;
  same(candidate: { press(): void }): boolean {
    return this.value === candidate;
  }
}
const holder = new Holder();
holder.value = button;
console.log("identity", holder.same(button));

// A data-only anonymous type is a width copy when nothing observes the
// identity, and a live view when a member is written through (Node writes
// the instance itself, so the write must reach it).
class Point {
  x = 1;
  y = 2;
}
const point = new Point();
const view: { x: number; y: number } = point;
console.log("view", view.x + view.y);
const alias: { x: number; y: number } = point;
alias.x = 10;
console.log("alias", alias.x + alias.y, "point", point.x + point.y);

export {};
