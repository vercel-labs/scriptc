// The project declares the global the way @types/node does; calling the
// constructor value refuses for the same reason constructing it does: the
// call can only produce an instance native code does not have (SC2020,
// host-global), where Node answers Node's callable FormData.
interface HostForm {
  readonly size: number;
}
declare var FormData: {
  new (): HostForm;
  (): HostForm;
  readonly prototype: HostForm;
};
const form = FormData();
console.log(form.size);
