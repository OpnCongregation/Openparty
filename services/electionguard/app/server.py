"""
HTTP wrapper around core.py. Internal use only: the platform calls it over the private network with a shared bearer token, and it is not
published on any host port. It holds NO state and NO guardian secrets: every call carries everything it needs, and the guardian steps
(which use private keys) are not served unless EG_ENABLE_GUARDIAN_OPS=1, which exists for the local demo only.
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The ElectionGuard library logs raw cryptographic values at INFO and DEBUG. None of that may ever reach a log file.
logging.disable(logging.CRITICAL)

from . import core  # noqa: E402  (after the logging switch-off on purpose)

TOKEN = os.environ.get("EG_TOKEN", "")
MAX_BODY = int(os.environ.get("EG_MAX_BODY", str(128 * 1024 * 1024)))
GUARDIAN_OPS = os.environ.get("EG_ENABLE_GUARDIAN_OPS") == "1"

OPS = {
    "manifest": lambda b: core.build_manifest(b["election"]),
    "combine-keys": lambda b: core.combine_keys(b["public_keys"], b["n"], b["quorum"]),
    "context": lambda b: core.make_context(b["manifest"], b["joint_public_key"], b["n"], b["quorum"]),
    "encrypt": lambda b: core.encrypt(b["manifest"], b["context"], b["ballot_id"], b["choices"]),
    "check-ballot": lambda b: {"ok": core.check_ballot(b["manifest"], b["context"], b["ballot"])},
    "tally": lambda b: core.tally(b["manifest"], b["context"], b["ballots"], b.get("previous")),
    "decrypt": lambda b: core.decrypt(b["manifest"], b["context"], b["tally"], b["public_keys"], b["submissions"]),
    "verify": lambda b: core.verify_election(b["manifest"], b["context"], b["ballots"], b["tally"]),
}
if GUARDIAN_OPS:  # DEMO ONLY: a real guardian runs these on their own device with guardian_tool.py
    OPS.update({
        "guardian/init": lambda b: core.guardian_init(b["id"], b["sequence_order"], b["n"], b["quorum"]),
        "guardian/backups": lambda b: core.guardian_backups(b["private"], b["public_keys"]),
        "guardian/receive": lambda b: core.guardian_receive(b["private"], b["backups"]),
        "guardian/shares": lambda b: core.guardian_shares(b["private"], b["manifest"], b["context"], b["tally"], b["public_keys"]),
    })


class Handler(BaseHTTPRequestHandler):
    server_version = "openparty-eg"
    sys_version = ""

    def log_message(self, *_a):  # never log request lines
        pass

    def _send(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _authorised(self) -> bool:
        if not TOKEN:
            return os.environ.get("EG_ALLOW_NO_TOKEN") == "1"
        got = self.headers.get("Authorization", "")
        return hmac.compare_digest(got.encode(), f"Bearer {TOKEN}".encode())

    def do_GET(self):
        if self.path == "/healthz":
            import electionguard
            return self._send(200, {"ok": True, "guardian_ops": GUARDIAN_OPS, "library": getattr(electionguard, "__version__", "1.4.0")})
        self._send(404, {"error": "not_found"})

    def do_POST(self):
        if not self._authorised():
            return self._send(401, {"error": "unauthorized"})
        op = self.path[len("/v1/"):] if self.path.startswith("/v1/") else ""
        fn = OPS.get(op)
        if fn is None:
            return self._send(404, {"error": "unknown_operation"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._send(400, {"error": "bad_length"})
        if length <= 0 or length > MAX_BODY:
            return self._send(413, {"error": "too_large"})
        try:
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("body must be an object")
        except ValueError:
            return self._send(400, {"error": "bad_json"})
        try:
            self._send(200, fn(body))
        except core.ElectionError as e:
            self._send(422, {"error": "refused", "message": str(e)})
        except KeyError as e:
            self._send(400, {"error": "missing_field", "message": str(e)})
        except Exception:  # noqa: BLE001 - the detail could contain secrets; the caller gets no detail
            self._send(500, {"error": "internal"})


def main():
    if not TOKEN and os.environ.get("EG_ALLOW_NO_TOKEN") != "1":
        sys.exit("EG_TOKEN is not set (16+ characters). Refusing to start an unauthenticated service.")
    if TOKEN and len(TOKEN) < 16:
        sys.exit("EG_TOKEN is too short (16 characters or more).")
    port = int(os.environ.get("PORT", "8090"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
