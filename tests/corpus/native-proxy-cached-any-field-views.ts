// A boxed class hierarchy with getters and an `any`-typed cache field that
// holds a native Proxy: the accessor views the dynamic dispatch builds for
// every class in the hierarchy generate once per class, not once per copy a
// class table could register.
function proxyFor(owner: any): any {
  return new Proxy({} as any, {
    get(t: any, k: any): any {
      return owner.getAttribute(k);
    },
  });
}
class Element {
  cache: any = null;
  getAttribute(name: string): string {
    return "value:" + name;
  }
  get parentNode(): Element | null {
    return this;
  }
  get nextSibling(): this | null {
    return null;
  }
  get ownerDocument(): Element {
    return this;
  }
  get dataset(): any {
    if (this.cache === null) this.cache = proxyFor(this);
    return this.cache;
  }
}
class HTMLElement extends Element {
  get parentNode(): Element | null {
    return this;
  }
  get nextSibling(): this | null {
    return null;
  }
  get style(): any {
    return this.dataset;
  }
  get firstElementChild(): HTMLElement | null {
    return null;
  }
}
class HTMLDivElement extends HTMLElement {
  get align(): string {
    return "";
  }
}
function asUnknown(v: unknown): any {
  return v;
}
const div = asUnknown(new HTMLDivElement());
const element = asUnknown(new HTMLElement());
const base = asUnknown(new Element());
console.log(div.id, div.dataset.id, element.style.title, base.dataset.href);
console.log(div.parentNode === div, element.firstElementChild, base.nextSibling);
