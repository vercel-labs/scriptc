function status(code) {
  return code + 1;
}
status.message = { 200: "OK", 404: "Not Found", 500: "Internal Server Error" };
status.codes = [200, 404, 500];
status.redirect = { 301: true, 302: true };
status.isOk = function (code) {
  return code === 200;
};
module.exports = status;
