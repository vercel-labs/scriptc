const os = require('os'),
  process = require('process');

exports.PROTOCOL = {
  TCP: 'tcp',
  UDS: 'uds',
  UDP: 'udp',
  STREAM: 'stream'
};

/**
 * Determines error codes that signify a connection to a Unix Domain Socket (UDS)
 * has failed in a way that can be retried. This codes are OS-specific.
 * @returns {number[]} An array of the error codes.
 */
function udsErrors() {
  if (process.platform === 'linux') {
    return [
      os.constants.errno.ENOTCONN,
      os.constants.errno.ECONNREFUSED,
    ];
  }

  if (process.platform === 'darwin') {
    return [
      os.constants.errno.EDESTADDRREQ,
      os.constants.errno.ECONNRESET,
    ];
  }

  // Unknown / not yet implemented
  return [];
}

exports.udsErrors = udsErrors;
