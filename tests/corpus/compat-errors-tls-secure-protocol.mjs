// tls.createSecureContext validates secureProtocol: unknown methods and the
// disabled SSLv2/SSLv3 families raise ERR_TLS_INVALID_PROTOCOL_METHOD, and an
// explicit version beside it raises ERR_TLS_PROTOCOL_VERSION_CONFLICT.
import tls from "node:tls";

const attempt = (label, options) => {
  try {
    tls.createSecureContext(options);
    console.log(label, "ok");
  } catch (error) {
    console.log(label, error.name, error.code, JSON.stringify(error.message));
  }
};

for (const method of ["bogus", "SSLv2_method", "SSLv2_client_method", "SSLv3_method", "TLSv1_3_method"]) {
  attempt(method, { secureProtocol: method });
}
attempt("valid", { secureProtocol: "TLSv1_2_method" });
attempt("valid-client", { secureProtocol: "TLSv1_client_method" });
attempt("conflict", { secureProtocol: "bogus", minVersion: "TLSv1.2" });
attempt("conflict-number", { secureProtocol: 1, maxVersion: "TLSv1.2" });
