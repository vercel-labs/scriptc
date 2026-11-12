export class Base {
  v = 1;
  doubled() {
    return this.v * 2;
  }
}

/** A mixin whose only addition is a static, so both arms of a computed
 * heritage produce the same instance shape. */
export function tagged(B: typeof Base) {
  return class extends B {
    static tag = "tagged";
  };
}

/** A mixin that adds an instance field. */
export function plain(B: typeof Base) {
  return class extends B {
    extra = 2;
  };
}

/** Labels in the order a static initializer records them. */
export const seen: string[] = [];
export function note(label: string): string {
  seen.push(label);
  return label;
}

/** A mixin whose static initializer records that it ran. */
export function logged(B: typeof Base) {
  return class extends B {
    static label = note("logged");
  };
}
