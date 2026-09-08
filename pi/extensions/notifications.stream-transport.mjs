/**
 * notifications.stream-transport.mjs — the dedicated stream-opening
 * transport for the presentation-SSE worker (autonomy/t:277).
 *
 * WHY THIS EXISTS: the worker's control requests (whoami, lease
 * status/claim/renew, ack) go through fetch on Node's default dispatcher.
 * On a Node/Undici build that upgrades the shared TLS connection to
 * HTTP/2, one long-lived SSE stream shares that single H2 connection with
 * every control request — and a held stream demonstrably blocks them
 * (lease renewals time out until the stream ends). The correction is
 * stream/control SEPARATION, not a global dispatcher change: the stream
 * gets its OWN dedicated HTTP/1.1 connection, control requests keep the
 * untouched fetch path.
 *
 * This module opens exactly ONE request/response on one owned socket:
 *   - `agent: false` — the connection is never pooled or shared; no
 *     control request can ever reuse it (and vice versa).
 *   - `ALPNProtocols: ["http/1.1"]` — the stream request offers HTTP/1.1
 *     ALONE, so an H2-advertising server negotiates HTTP/1.1 for this
 *     connection. That is a transport-compatibility choice, NOT a TLS
 *     weakening: certificate and hostname verification stay at the Node
 *     defaults; rejectUnauthorized / NODE_TLS_REJECT_UNAUTHORIZED are
 *     never touched.
 *   - Redirects are REFUSED, never followed: a 3xx ends the request
 *     before anything — especially credentials — is sent elsewhere.
 *   - The AbortSignal works BEFORE and AFTER response headers: a
 *     pre-header abort rejects the open promise; a post-header abort
 *     destroys the socket, which makes the body iteration REJECT (an
 *     abort must never masquerade as a clean end-of-stream).
 *   - Every exit path (3xx, non-success status, request/response error,
 *     abort, clean end) releases the owned socket; nothing stays open.
 *
 * The returned shape is the MINIMAL response surface connectStream needs:
 * { status, ok, body, destroy } where body is an async iterable of
 * chunks. This is not a fetch re-implementation: framing, validation
 * gates, lease and reconnect policy all remain in the worker.
 */

import http from "node:http";
import https from "node:https";

/** The stream request offers HTTP/1.1 alone; an H2 server must pick it. */
const STREAM_ALPN = ["http/1.1"];

function abortError() {
	const err = new Error("the stream request was aborted");
	err.streamAborted = true;
	return err;
}

/**
 * Open ONE dedicated HTTP/1.1 POST connection for a long-lived SSE
 * stream. Resolves once response headers arrive; rejects on connection /
 * TLS / redirect / abort failures. `signal` (optional) aborts the request
 * and later the response body. `destroy()` releases the socket on any
 * early exit and is safe to call more than once.
 */
export function openDedicatedStream({ url, headers, body, signal }) {
	if (!(url instanceof URL) || (url.protocol !== "https:" && url.protocol !== "http:")) {
		return Promise.reject(new Error("the stream transport requires an http(s) URL (static class)"));
	}
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const secure = url.protocol === "https:";
		const transport = secure ? https : http;
		const req = transport.request({
			method: "POST",
			hostname: url.hostname,
			port: url.port || (secure ? 443 : 80),
			path: `${url.pathname}${url.search}`,
			headers: { ...headers, "content-length": Buffer.byteLength(body) },
			// DEDICATED CONNECTION: never pooled, never shared with the
			// default dispatcher the control requests use — in either
			// direction.
			agent: false,
			// HTTPS only: offer HTTP/1.1 alone so an H2-advertising server
			// negotiates HTTP/1.1 for THIS connection. Certificate and
			// hostname verification are untouched (Node defaults).
			...(secure ? { ALPNProtocols: STREAM_ALPN } : {}),
		});
		let settled = false;
		let response = null;
		const detach = () => signal?.removeEventListener("abort", onAbort);
		const settle = (fn, value) => {
			if (settled) return;
			settled = true;
			// On REJECTION the request is over — detach. On RESOLUTION the
			// abort listener MUST STAY ATTACHED: a held body (the normal SSE
			// case) stays abortable for its whole lifetime, and detaches only
			// when the response actually closes.
			if (fn !== resolve) detach();
			fn(value);
		};
		const onAbort = () => {
			// BEFORE headers: the request 'error' below rejects the promise.
			// AFTER headers: destroying the RESPONSE with the abort error
			// makes the body iteration reject.
			if (response) response.destroy(abortError());
			else req.destroy(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		req.on("response", (res) => {
			response = res;
			if (res.statusCode >= 300 && res.statusCode < 400) {
				// Redirects are refused, never followed: neither the redirect
				// destination nor any other origin is contacted with the
				// request or its credentials.
				res.destroy();
				settle(reject, new Error("the stream request redirect was refused (static class)"));
				return;
			}
			// Protective no-op: an 'error' with no listener would crash the
			// process. The body's async iterator still observes the error and
			// rejects on it, so real failures keep reaching connectStream.
			res.on("error", () => {});
			res.on("close", detach);
			settle(resolve, {
				status: res.statusCode,
				ok: res.statusCode >= 200 && res.statusCode < 300,
				body: res,
				destroy: () => {
					res.destroy();
					req.destroy();
				},
			});
		});
		req.on("error", (err) => settle(reject, err));
		req.end(body);
	});
}
