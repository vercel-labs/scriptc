// @deferred-fences: 2
// `Intl.NumberFormat` has no static lowering (SC2020's standard-library
// fence), so both field initializers stay runtime fences on these untaken
// paths; the Object/Reflect reflection entry points now lower.
class InstanceProbe {
  value = new Intl.NumberFormat().format(1);
}
if (process.env.SCRIPTC_NEVER === "yes") {
  console.log(new InstanceProbe().value);
  class StaticProbe {
    static value = new Intl.NumberFormat().format(1);
  }
  console.log(StaticProbe.value);
}
console.log("deferred fields");
