// A style declaration class and a Proxy view over it, as a DOM runtime's
// getComputedStyle hands out: the view answers every property name from
// the declaration's table, camelCase mapped to dashed.
export class CSSStyleDeclaration {
  private values = new Map<string, string>();
  getPropertyValue(name: string): string {
    return this.values.get(name) ?? "";
  }
  setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }
  get color(): string {
    return this.getPropertyValue("color");
  }
}

export interface StyleView {
  getPropertyValue(name: string): string;
  readonly color: string;
}

export interface StyleTable {
  getPropertyValue(name: string): string;
  [name: string]: any;
}

function cssName(key: string): string {
  let out = "";
  for (const c of key) out += c >= "A" && c <= "Z" ? "-" + c.toLowerCase() : c;
  return out;
}

const views = new WeakMap<CSSStyleDeclaration, any>();

/** The view of `decl`, made once, so a caller always sees the same object. */
export function declarationView(decl: CSSStyleDeclaration): any {
  const made = views.get(decl);
  if (made !== undefined) return made;
  const view = new Proxy({} as any, {
    get(_target: any, key: any): any {
      if (typeof key !== "string") return undefined;
      if (key === "getPropertyValue") return (name: string) => decl.getPropertyValue(name);
      return decl.getPropertyValue(cssName(key));
    },
    set(_target: any, key: any, value: any): any {
      decl.setProperty(cssName(String(key)), String(value));
      return true;
    },
    has(_target: any, key: any): any {
      return typeof key === "string" && (key === "getPropertyValue" || decl.getPropertyValue(cssName(key)) !== "");
    },
  });
  views.set(decl, view);
  return view;
}

export class Element {
  readonly id: string;
  private decl: CSSStyleDeclaration | null = null;
  constructor(id: string) {
    this.id = id;
  }
  get declaration(): CSSStyleDeclaration {
    if (this.decl === null) {
      this.decl = new CSSStyleDeclaration();
      this.decl.setProperty("display", "block");
      this.decl.setProperty("color", "rgb(0, 128, 0)");
      this.decl.setProperty("margin-top", this.id.length + "px");
    }
    return this.decl;
  }
  get computedStyle(): any {
    return declarationView(this.declaration);
  }
}

/** Untyped, as a runtime declares a function whose value is a Proxy. */
export function getComputedStyle(el: Element): any {
  return el.computedStyle;
}

/** Interface-typed: the same view, or the declaration itself. */
export function styleView(el: Element, proxied: boolean): StyleView {
  return proxied ? declarationView(el.declaration) : el.declaration;
}

export function styleTable(el: Element): StyleTable {
  return declarationView(el.declaration);
}
