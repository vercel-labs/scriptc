// A checked-dynamic filter call with no predicate reaches the runtime method,
// which throws the same callback TypeError as Node instead of crashing scriptc.
const source = JSON.parse('{"zero":0,"one":1}');
try {
  Object.keys(source).filter();
} catch (error) {
  console.log(error.name, error.message);
}

const custom = JSON.parse('{}');
custom.filter = (callback) => callback();
custom.filter(() => {
  console.log('custom filter');
});
