#!/usr/bin/env python3
"""Tiny local HTTP fixture for autonomy-http tests — dummy auth only.

Never holds a real credential: the only token it accepts is the literal
string "dummy-test-token". Binds loopback. Writes "<pid> <port>" to
--ready-file so the test harness (Nu) can wait for it and kill it by pid.

Routes (chosen to exercise the shared client's contract):
  GET  /whoami               -> 200 {"user": "fixture-agent", ...}   (bearer required)
  GET  /notifications/list   -> 200 {items: [...], retracted: 0}     (large string revision)
  GET  /redirect             -> 302 -> /whoami                       (client must refuse)
  GET  /html                 -> 200 text/html login page             (non-JSON shape)
  POST /notifications/dismiss-revision -> 200, or 409 when revision == "111" (stale)
  POST /feed                 -> 200 {author, hash, ...}
Anything without the exact bearer token gets 401.
"""
import argparse
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = "dummy-test-token"
SERVER = None


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        return self.headers.get("Authorization", "") == f"Bearer {TOKEN}"

    def do_GET(self):
        if self.path == "/shutdown":
            # graceful stop so the test harness sees a normal exit, not SIGTERM
            self._send(200, {"status": "shutting down"})
            threading.Thread(target=SERVER.shutdown, daemon=True).start()
            return
        if not self._authorized():
            return self._send(401, {"error": "unauthorized"})
        if self.headers.get("X-Auth-User") or self.headers.get("X-Auth-Actor"):
            # operator-identity headers are daemon-internal; a client that sends
            # them is impersonating — refuse so the shared client proves it does not
            return self._send(400, {"error": "client sent X-Auth-User/X-Auth-Actor (forbidden impersonation headers)"})
        if self.path.startswith("/tasks/"):
            # task detail route (autonomy/t:268 prep): the canonical key must
            # arrive as ONE URL-encoded path segment — a literal "/" inside the
            # segment would change routing and is refused
            segment = self.path[len("/tasks/"):]
            if "/" in segment:
                return self._send(400, {"error": "task key must be a single URL-encoded path segment (whole key encoded once)"})
            from urllib.parse import unquote
            key = unquote(segment)
            if key == "/autonomy/t:261":
                return self._send(200, {
                    "state": "in_progress",
                    "criteria": [{"id": "c-1"}, {"id": "c-2"}],
                    "title": "fixture task for queue-watch proof",
                })
            return self._send(404, {"error": f"no fixture task for key {key!r}"})
        if self.path == "/whoami":
            return self._send(200, {"user": "fixture-agent", "actor_id": "fixture-uuid"})
        if self.path.startswith("/notifications/list"):
            item = {
                "place": "feed:main",
                "sender": "nir",
                "text": "fixture row",
                "resource_key": "feed:main.m:abc123",
                "handle": "feed-post-abc123",
                "revision": "98765432109876543210",
            }
            return self._send(200, {"items": [item], "retracted": 0})
        if self.path.startswith("/notifications/badshape"):
            # list response missing `items` — must never read as an empty queue
            return self._send(200, {"retracted": 0})
        if self.path.startswith("/notifications/numrev"):
            # revision as a JSON NUMBER — the client must refuse it
            item = {
                "place": "feed:main", "sender": None, "text": "x",
                "resource_key": None, "handle": "h-1", "revision": 98765432109876543210,
            }
            return self._send(200, {"items": [item], "retracted": 0})
        if self.path.startswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", "/whoami")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.startswith("/html"):
            page = b"<html>login page</html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)
            return
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._authorized():
            return self._send(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        if self.path == "/notifications/dismiss-revision":
            req = json.loads(raw)
            if req.get("revision") == "111":
                return self._send(409, {"error": "stale revision: re-list and reassess"})
            return self._send(200, {
                "handle": req.get("handle"),
                "revision": req.get("revision"),
                "status": "dismissed",
            })
        if self.path == "/feed":
            req = json.loads(raw)
            # wire contract (Peri candidate 5d7500aa, autonomy/t:268): reply_to,
            # when present, must be the ABSOLUTE owner-qualified main-feed member
            # form "/feed:main.m:<hash>"; legacy numeric / bare hash / m:-only /
            # relative forms are refused before lookup; a well-formed ref naming a
            # DIFFERENT feed owner is refused as an owner mismatch (also before
            # lookup). The ref is otherwise sent by the client unchanged.
            rt = req.get("reply_to")
            if rt is not None:
                if not (isinstance(rt, str) and re.fullmatch(r"/feed:[a-z0-9.-]+\.m:[0-9a-z]{6,16}", rt)):
                    return self._send(400, {"error": f"reply_to must be the absolute owner-qualified form /feed:main.m:<hash>, got {rt!r}"})
                if not rt.startswith("/feed:main.m:"):
                    return self._send(400, {"error": f"reply_to {rt!r} addresses a different feed owner, not feed:main (owner match refuses before lookup)"})
            return self._send(200, {
                "author": req.get("author"),
                "hash": "abc123",
                "references": [],
                "unresolved": [],
            })
        return self._send(404, {"error": "not found"})

    def log_message(self, *args):
        pass  # quiet: never log token-bearing headers


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--ready-file", default="")
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    SERVER = srv
    if args.ready_file:
        with open(args.ready_file, "w") as f:
            f.write(f"{os.getpid()} {srv.server_address[1]}\n")
    srv.serve_forever()
