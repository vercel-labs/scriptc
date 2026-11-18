// A member read through a constant holding the value: the alias is the same
// constructor, so the member refuses there too (SC2020, host-global), where
// Node answers it.
declare var FormData: {
  new (): unknown;
  readonly prototype: object;
  readonly OPEN: number;
};
const Form = FormData;
console.log(Form.OPEN);
