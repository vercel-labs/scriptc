// Copyright (C) 2015 André Bargull. All rights reserved.
// This adaptation of Test262's testTypedArray.js is governed by the BSD license in vendor/LICENSE.
// It keeps the upstream constructor lists and argument factories. The host
// assert.js is replaced by harness.ts, so isPrimitive is defined here, and
// Test262Error is a class that needs `new`. Factories bind through a
// closure, and feature checks use typeof (and tolerate an ArrayBuffer
// without a reachable prototype, which then has no resizable or immutable
// factories). %TypedArray% (`TypedArray`) is left out: tests that name it
// are excluded.

function isPrimitive(value) {
  return !value || (typeof value !== "object" && typeof value !== "function");
}

var floatArrayConstructors = [
  Float64Array,
  Float32Array
];

var nonClampedIntArrayConstructors = [
  Int32Array,
  Int16Array,
  Int8Array,
  Uint32Array,
  Uint16Array,
  Uint8Array
];

var intArrayConstructors = nonClampedIntArrayConstructors.concat([Uint8ClampedArray]);

// Float16Array is a newer feature
// adding it to this list unconditionally would cause implementations lacking it to fail every test which uses it
if (typeof Float16Array !== "undefined") {
  floatArrayConstructors.push(Float16Array);
}

var bigIntArrayConstructors = [];
if (typeof BigInt64Array !== "undefined") {
  bigIntArrayConstructors.push(BigInt64Array);
}
if (typeof BigUint64Array !== "undefined") {
  bigIntArrayConstructors.push(BigUint64Array);
}

var typedArrayConstructors = floatArrayConstructors.concat(intArrayConstructors);

var allTypedArrayConstructors = typedArrayConstructors.concat(bigIntArrayConstructors);

function makePassthrough(TA, primitiveOrIterable) {
  return primitiveOrIterable;
}

function makeArray(TA, primitiveOrIterable) {
  if (isPrimitive(primitiveOrIterable)) {
    var n = Number(primitiveOrIterable);
    // Only values between 0 and 2**53 - 1 inclusive can get mapped into TA contents.
    if (!(n >= 0 && n < 9007199254740992)) return primitiveOrIterable;
    return Array.from({ length: n }, function() { return "0"; });
  }
  return Array.from(primitiveOrIterable);
}

function makeArrayLike(TA, primitiveOrIterable) {
  var arr = makeArray(TA, primitiveOrIterable);
  if (isPrimitive(arr)) return arr;
  var obj = { length: arr.length };
  for (var i = 0; i < obj.length; i++) obj[i] = arr[i];
  return obj;
}

var makeIterable;
if (typeof Symbol !== "undefined") {
  makeIterable = function makeIterable(TA, primitiveOrIterable) {
    var src = makeArray(TA, primitiveOrIterable);
    if (isPrimitive(src)) return src;
    var obj = {};
    obj[Symbol.iterator] = function() { return src[Symbol.iterator](); };
    return obj;
  };
}

function makeArrayBuffer(TA, primitiveOrIterable) {
  var arr = makeArray(TA, primitiveOrIterable);
  if (isPrimitive(arr)) return arr;
  return new TA(arr).buffer;
}

var makeResizableArrayBuffer, makeGrownArrayBuffer, makeShrunkArrayBuffer, makeImmutableArrayBuffer;
if (typeof ArrayBuffer.prototype === "object" && typeof ArrayBuffer.prototype.resize === "function") {
  var copyIntoArrayBuffer = function(destBuffer, srcBuffer) {
    var destView = new Uint8Array(destBuffer);
    var srcView = new Uint8Array(srcBuffer);
    for (var i = 0; i < srcView.length; i++) destView[i] = srcView[i];
    return destBuffer;
  };

  makeResizableArrayBuffer = function makeResizableArrayBuffer(TA, primitiveOrIterable) {
    if (isPrimitive(primitiveOrIterable)) {
      var n = Number(primitiveOrIterable) * TA.BYTES_PER_ELEMENT;
      if (!(n >= 0 && n < 9007199254740992)) return primitiveOrIterable;
      return new ArrayBuffer(n, { maxByteLength: n * 2 });
    }
    var fixed = makeArrayBuffer(TA, primitiveOrIterable);
    var byteLength = fixed.byteLength;
    var resizable = new ArrayBuffer(byteLength, { maxByteLength: byteLength * 2 });
    return copyIntoArrayBuffer(resizable, fixed);
  };

  makeGrownArrayBuffer = function makeGrownArrayBuffer(TA, primitiveOrIterable) {
    if (isPrimitive(primitiveOrIterable)) {
      var n = Number(primitiveOrIterable) * TA.BYTES_PER_ELEMENT;
      if (!(n >= 0 && n < 9007199254740992)) return primitiveOrIterable;
      var grown = new ArrayBuffer(Math.floor(n / 2), { maxByteLength: n });
      grown.resize(n);
    }
    var fixed = makeArrayBuffer(TA, primitiveOrIterable);
    var byteLength = fixed.byteLength;
    var grown = new ArrayBuffer(Math.floor(byteLength / 2), { maxByteLength: byteLength });
    grown.resize(byteLength);
    return copyIntoArrayBuffer(grown, fixed);
  };

  makeShrunkArrayBuffer = function makeShrunkArrayBuffer(TA, primitiveOrIterable) {
    if (isPrimitive(primitiveOrIterable)) {
      var n = Number(primitiveOrIterable) * TA.BYTES_PER_ELEMENT;
      if (!(n >= 0 && n < 9007199254740992)) return primitiveOrIterable;
      var shrunk = new ArrayBuffer(n * 2, { maxByteLength: n * 2 });
      shrunk.resize(n);
    }
    var fixed = makeArrayBuffer(TA, primitiveOrIterable);
    var byteLength = fixed.byteLength;
    var shrunk = new ArrayBuffer(byteLength * 2, { maxByteLength: byteLength * 2 });
    copyIntoArrayBuffer(shrunk, fixed);
    shrunk.resize(byteLength);
    return shrunk;
  };
}
if (typeof ArrayBuffer.prototype === "object" && typeof ArrayBuffer.prototype.transferToImmutable === "function") {
  makeImmutableArrayBuffer = function makeImmutableArrayBuffer(TA, primitiveOrIterable) {
    if (isPrimitive(primitiveOrIterable)) {
      var n = Number(primitiveOrIterable) * TA.BYTES_PER_ELEMENT;
      if (!(n >= 0 && n < 9007199254740992)) return primitiveOrIterable;
      return (new ArrayBuffer(n)).transferToImmutable();
    }
    var mutable = makeArrayBuffer(TA, primitiveOrIterable);
    return mutable.transferToImmutable();
  };
}

var typedArrayCtorArgFactories = [makePassthrough, makeArray, makeArrayLike];
if (makeIterable) typedArrayCtorArgFactories.push(makeIterable);
typedArrayCtorArgFactories.push(makeArrayBuffer);
if (makeResizableArrayBuffer) typedArrayCtorArgFactories.push(makeResizableArrayBuffer);
if (makeGrownArrayBuffer) typedArrayCtorArgFactories.push(makeGrownArrayBuffer);
if (makeShrunkArrayBuffer) typedArrayCtorArgFactories.push(makeShrunkArrayBuffer);
if (makeImmutableArrayBuffer) typedArrayCtorArgFactories.push(makeImmutableArrayBuffer);


function ctorArgFactoryMatchesSome(argFactory, features) {
  for (var i = 0; i < features.length; ++i) {
    switch (features[i]) {
      case "passthrough":
        if (argFactory === makePassthrough) return true;
        break;
      case "arraylike":
        if (argFactory === makeArray || argFactory === makeArrayLike) return true;
        break;
      case "iterable":
        if (argFactory === makeIterable) return true;
        break;
      case "arraybuffer":
        if (
          argFactory === makeArrayBuffer ||
          argFactory === makeResizableArrayBuffer ||
          argFactory === makeGrownArrayBuffer ||
          argFactory === makeShrunkArrayBuffer ||
          argFactory === makeImmutableArrayBuffer
        ) {
          return true;
        }
        break;
      case "resizable":
        if (
          argFactory === makeResizableArrayBuffer ||
          argFactory === makeGrownArrayBuffer ||
          argFactory === makeShrunkArrayBuffer
        ) {
          return true;
        }
        break;
      case "immutable":
        if (argFactory === makeImmutableArrayBuffer) return true;
        break;
      default:
        throw new Test262Error("unknown feature: " + features[i]);
    }
  }
  return false;
}


function bindArgFactory(argFactory, constructor) {
  return function(primitiveOrIterable) {
    return argFactory(constructor, primitiveOrIterable);
  };
}

function testWithAllTypedArrayConstructors(f, constructors, includeArgFactories, excludeArgFactories) {
  var ctors = constructors || allTypedArrayConstructors;
  var ctorArgFactories = typedArrayCtorArgFactories;
  if (includeArgFactories) {
    ctorArgFactories = [];
    for (var i = 0; i < typedArrayCtorArgFactories.length; ++i) {
      if (ctorArgFactoryMatchesSome(typedArrayCtorArgFactories[i], includeArgFactories)) {
        ctorArgFactories.push(typedArrayCtorArgFactories[i]);
      }
    }
  }
  if (excludeArgFactories) {
    ctorArgFactories = ctorArgFactories.slice();
    for (var i = ctorArgFactories.length - 1; i >= 0; --i) {
      if (ctorArgFactoryMatchesSome(ctorArgFactories[i], excludeArgFactories)) {
        ctorArgFactories.splice(i, 1);
      }
    }
  }
  if (ctorArgFactories.length === 0) {
    throw new Test262Error("no arg factories match include " + includeArgFactories + " and exclude " + excludeArgFactories);
  }
  for (var k = 0; k < ctorArgFactories.length; ++k) {
    var argFactory = ctorArgFactories[k];
    for (var i = 0; i < ctors.length; ++i) {
      var constructor = ctors[i];
      var boundArgFactory = bindArgFactory(argFactory, constructor);
      try {
        f(constructor, boundArgFactory);
      } catch (e) {
        e.message += " (Testing with " + constructor.name + " and " + argFactory.name + ".)";
        throw e;
      }
    }
  }
}

function testWithTypedArrayConstructors(f, constructors, includeArgFactories, excludeArgFactories) {
  var ctors = constructors || typedArrayConstructors;
  testWithAllTypedArrayConstructors(f, ctors, includeArgFactories, excludeArgFactories);
}

function testWithBigIntTypedArrayConstructors(f, constructors, includeArgFactories, excludeArgFactories) {
  var ctors = constructors || [BigInt64Array, BigUint64Array];
  testWithAllTypedArrayConstructors(f, ctors, includeArgFactories, excludeArgFactories);
}

var nonAtomicsFriendlyTypedArrayConstructors = floatArrayConstructors.concat([Uint8ClampedArray]);
function testWithNonAtomicsFriendlyTypedArrayConstructors(f, includeArgFactories, excludeArgFactories) {
  testWithAllTypedArrayConstructors(
    f,
    nonAtomicsFriendlyTypedArrayConstructors,
    includeArgFactories,
    excludeArgFactories
  );
}

function testWithAtomicsFriendlyTypedArrayConstructors(f, includeArgFactories, excludeArgFactories) {
  testWithAllTypedArrayConstructors(
    f,
    [
      Int32Array,
      Int16Array,
      Int8Array,
      Uint32Array,
      Uint16Array,
      Uint8Array,
    ],
    includeArgFactories,
    excludeArgFactories
  );
}

function testTypedArrayConversions(byteConversionValues, fn) {
  var values = byteConversionValues.values;
  var expected = byteConversionValues.expected;

  testWithTypedArrayConstructors(function(TA) {
    var name = TA.name.slice(0, -5);

    return values.forEach(function(value, index) {
      var exp = expected[name][index];
      var initial = 0;
      if (exp === 0) {
        initial = 1;
      }
      fn(TA, value, exp, initial);
    });
  }, null, ["passthrough"]);
}

function isFloatTypedArrayConstructor(arg) {
  return floatArrayConstructors.indexOf(arg) !== -1;
}

function floatTypedArrayConstructorPrecision(FA) {
  if (typeof Float16Array !== "undefined" && FA === Float16Array) {
    return "half";
  } else if (FA === Float32Array) {
    return "single";
  } else if (FA === Float64Array) {
    return "double";
  } else {
    throw new Error("Malformed test - floatTypedArrayConstructorPrecision called with non-float TypedArray");
  }
}
