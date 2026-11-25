// http.mjs — JSON helpers for the plugin's health route, matching the
// conventions of the session-delete plugin so both trust the same requests
// behind the reverse proxy.

/**
 * Send a JSON response.
 * @param {import('node:http').ServerResponse} res - the HTTP response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 */
export function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Accept requests without an Origin header (same-origin fetches and curl) and
 * origins that match the request's own Host or are loopback.
 * @param {import('node:http').IncomingMessage} req - the HTTP request.
 * @returns {boolean} true when the request may be served.
 */
export function isTrustedOrigin(req) {
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  let hostname
  try {
    hostname = new URL(origin).hostname
  } catch {
    return false
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1') return true
  const host = req?.headers?.host
  if (typeof host === 'string' && host.length > 0) {
    const hostNameOnly = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    if (hostNameOnly.toLowerCase() === hostname.toLowerCase()) return true
  }
  return false
}
