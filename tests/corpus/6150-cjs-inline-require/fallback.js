const preferred = undefined;
module.exports =
  preferred ||
  function fallback() {
    return "fallback";
  };
