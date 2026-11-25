import { Widget } from "./widget.js";

// Generated code leaves the template argument off, so the default applies.
export class Defaulted extends Widget {}

// The written spelling of the same argument, and the JSDoc heritage form.
/** @extends {Widget<any>} */
export class Written extends Widget {
  constructor() {
    super("written");
    this.extra = 1;
  }
}
