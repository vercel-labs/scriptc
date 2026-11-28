/* A dynamic key cannot adopt an accessor-bearing record: the checked
 * conversion has no extraction for a shape whose accessor slots are
 * closures, so the collection keeps its ordinary lowering refusal. */
type Layer = {
  parent: Layer | null;
  get label(): string;
};

const stored = new Set<Layer>();

function add(value: any): void {
  stored.add(value);
}

add({
  parent: null,
  get label() {
    return "x";
  },
});
