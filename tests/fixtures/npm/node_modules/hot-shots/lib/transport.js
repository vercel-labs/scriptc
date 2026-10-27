const assert = require('assert');
const dgram = require('dgram');
const net = require('net');
const dns = require('dns');
const { PROTOCOL } = require('./constants');

// Imported below, only if needed
let unixDgram;

const UDS_PATH_DEFAULT = '/var/run/datadog/dsd.socket';

const addEol = (buf) => {
  let msg = buf.toString();
  if (msg.length > 0 && msg[msg.length - 1] !== '\n') {
    msg += '\n';
  }
  return msg;
};

// interface Transport {
//   emit(name: string, payload: any):void;
//   on(name: string, listener: Function):void;
//   removeListener(name: string, listener: Function):void;
//   send(buf: Buffer, callback: Function):void;
//   close():void;
//   unref(): void;
// }
const createTcpTransport = args => {
  const socket = net.connect(args.port, args.host);
  socket.setKeepAlive(true);
  // do not block node from shutting down
  socket.unref();
  return {
    emit: socket.emit.bind(socket),
    on: socket.on.bind(socket),
    removeListener: socket.removeListener.bind(socket),
    send: (buf, callback) => {
      socket.write(addEol(buf), 'ascii', callback);
    },
    close: () => socket.destroy(),
    unref: socket.unref.bind(socket)

  };
};

const createUdpTransport = args => {
  const socket = dgram.createSocket('udp4');
  // do not block node from shutting down
  socket.unref();

  const dnsResolutionData = {
    timestamp: new Date(0),
    resolvedAddress: undefined
  };

  const sendUsingDnsCache = (callback, buf) => {
    const now = Date.now();
    if (dnsResolutionData.resolvedAddress === undefined || (now - dnsResolutionData.timestamp > args.cacheDnsTtl)) {
      dns.lookup(args.host, (error, address) => {
        if (error) {
          callback(error);
          return;
        }
        dnsResolutionData.resolvedAddress = address;
        dnsResolutionData.timestamp = now;
        socket.send(buf, 0, buf.length, args.port, dnsResolutionData.resolvedAddress, callback);
      });
    } else {
      socket.send(buf, 0, buf.length, args.port, dnsResolutionData.resolvedAddress, callback);
    }
  };

  return {
    emit: socket.emit.bind(socket),
    on: socket.on.bind(socket),
    removeListener: socket.removeListener.bind(socket),
    send: function (buf, callback) {
      if (args.cacheDns) {
        sendUsingDnsCache(callback, buf);
      } else {
        socket.send(buf, 0, buf.length, args.port, args.host, callback);
      }
    },
    close: socket.close.bind(socket),
    unref: socket.unref.bind(socket)
  };
};

const createUdsTransport = args => {
  try {
    // This will not always be available, as noted in the error message below
    unixDgram = require('unix-dgram'); // eslint-disable-line global-require
  } catch (err) {
    throw new Error(
      'The library `unix_dgram`, needed for the uds protocol to work, is not installed. ' +
        'You need to pick another protocol to use hot-shots. ' +
        'See the hot-shots README for additional details.'
    );
  }
  const udsPath = args.path ? args.path : UDS_PATH_DEFAULT;
  const socket = unixDgram.createSocket('unix_dgram');

  try {
    socket.connect(udsPath);
  } catch (err) {
    socket.close();
    throw err;
  }

  return {
    emit: socket.emit.bind(socket),
    on: socket.on.bind(socket),
    removeListener: socket.removeListener.bind(socket),
    send: socket.send.bind(socket),
    close: () => {
      socket.close();
      // close is synchronous, and the socket will not emit a
      // close event, hence emulating standard behaviour by doing this:
      socket.emit('close');
    },
    unref: () => {
      throw new Error('unix-dgram does not implement unref for sockets');
    }
  };
};

const createStreamTransport = (args) => {
  const stream = args.stream;
  assert(stream, '`stream` option required');

  return {
    emit: stream.emit.bind(stream),
    on: stream.on.bind(stream),
    removeListener: stream.removeListener.bind(stream),
    send: (buf, callback) => stream.write(addEol(buf), callback),
    close: () => {
      stream.destroy();

      // Node v8 doesn't fire `close` event on stream destroy.
      if (process.version.split('.').shift() === 'v8') {
        stream.emit('close');
      }
    },
    unref: () => {
      throw new Error('stream transport does not support unref');
    }
  };
};

module.exports = (instance, args) => {
  let transport = null;
  const protocol = args.protocol || PROTOCOL.UDP;

  try {
    if (protocol === PROTOCOL.TCP) {
      transport = createTcpTransport(args);
    } else if (protocol === PROTOCOL.UDS) {
      transport = createUdsTransport(args);
    } else if (protocol === PROTOCOL.UDP) {
      transport = createUdpTransport(args);
    } else if (protocol === PROTOCOL.STREAM) {
      transport = createStreamTransport(args);
    } else {
      throw new Error(`Unsupported protocol '${protocol}'`);
    }
    transport.type = protocol;
    transport.createdAt = Date.now();
  } catch (e) {
    if (instance.errorHandler) {
      instance.errorHandler(e);
    } else {
      console.error(e);
    }
  }

  return transport;
};
