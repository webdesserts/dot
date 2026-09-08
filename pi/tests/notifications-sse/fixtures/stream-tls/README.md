# Synthetic TLS fixture certificates — TEST-ONLY

These keys/certs exist solely for `../../transport.test.mjs`, which uses a
local HTTPS server advertising both `h2` and `http/1.1` via ALPN. The tests
verify native HTTP/2 stream/control multiplexing. The worker trusts this CA
exclusively through NODE_EXTRA_CA_CERTS inside the test.

- `ca.pem` — synthetic CA (CN=notifications-sse-test-ca)
- `server-key.pem` / `server-cert.pem` — localhost server key/cert
  (SAN: DNS:localhost, IP:127.0.0.1; signed by the CA above; expires
  2036)

Synthetic material, never a real credential, never used against any live
endpoint. If they expire, regenerate a CA + localhost-signed server cert
with the same SAN and commit the replacement.
