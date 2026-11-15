// @deferred-fences: 1
class InstanceProbe {
  value = Reflect.isExtensible({});
}
if (process.env.SCRIPTC_NEVER === "yes") {
  console.log(new InstanceProbe().value);
  class StaticProbe {
    static value = Reflect.isExtensible({});
  }
  console.log(StaticProbe.value);
}
console.log("deferred fields");
