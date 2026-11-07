interface Alpha {
  alphaField: string;
}
interface Beta {
  betaField: string;
}
type Compat = Alpha | Beta;

function check(v: Compat): void {
  if ("alphaField" in v) {
    console.log("in", v.alphaField.toUpperCase());
  } else {
    console.log("absent");
  }
  if ("betaField" in v) {
    console.log("beta", v.betaField);
  }
}

const beta = JSON.parse('{"betaField":"b","alphaField":"a"}') as Beta;
check(beta);
check({ alphaField: "x" });
