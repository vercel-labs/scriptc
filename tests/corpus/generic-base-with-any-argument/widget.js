// The shape a component compiler emits: a template whose argument defaults to
// `any`, with the type used by a field, an accessor, and a method.
/** @template [Props=any] */
export class Widget {
  /** @param {Props} [props] */
  constructor(props) {
    /** @type {Props | null} */
    this.props = props === undefined ? null : props;
  }

  /** @returns {string} */
  describe() {
    return `widget:${String(this.props)}`;
  }
}
