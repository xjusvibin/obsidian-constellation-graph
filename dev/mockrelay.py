"""A tiny stand-in for the ntfy relay, for testing on this computer only: POST /<topic> publishes, GET /<topic>/sse streams."""
import json, time, threading, uuid
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

LOCK = threading.Condition()
MSGS = {}      # topic -> [message, ...]
STATS = {"posted": 0}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.send_header("Content-Length", "0"); self.end_headers()

    def do_POST(self):
        topic = urlparse(self.path).path.strip("/")
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n).decode("utf8", "replace")
        msg = {"id": uuid.uuid4().hex[:12], "time": int(time.time()), "event": "message", "topic": topic, "message": body}
        with LOCK:
            MSGS.setdefault(topic, []).append(msg); STATS["posted"] += 1; LOCK.notify_all()
        data = json.dumps(msg).encode()
        self.send_response(200); self._cors(); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path); parts = u.path.strip("/").split("/")
        if parts == ["stats"]:
            data = json.dumps({"topics": len(MSGS), **STATS, "texts": [m["message"][:12] for t in MSGS.values() for m in t][:20]}).encode()
            self.send_response(200); self._cors(); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data); return
        if len(parts) != 2 or parts[1] != "sse":
            self.send_response(404); self._cors(); self.send_header("Content-Length", "0"); self.end_headers(); return
        topic = parts[0]; since = parse_qs(u.query).get("since", ["0s"])[0]
        now = int(time.time())
        cutoff = now - int(since[:-1]) if since.endswith("s") and since[:-1].isdigit() else (int(since) if since.isdigit() else 0)
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "text/event-stream"); self.send_header("Cache-Control", "no-cache"); self.end_headers()
        try:
            self.wfile.write(b'event: open\ndata: {"event":"open"}\n\n'); self.wfile.flush()
            with LOCK:
                lst = MSGS.setdefault(topic, [])
                idx = next((i for i, m in enumerate(lst) if m["time"] >= cutoff), len(lst))
            while True:
                with LOCK:
                    while idx >= len(MSGS.get(topic, [])):
                        if not LOCK.wait(10):
                            break
                    batch = MSGS.get(topic, [])[idx:]; idx += len(batch)
                if not batch:
                    self.wfile.write(b"event: keepalive\ndata: {\"event\":\"keepalive\"}\n\n"); self.wfile.flush(); continue
                for m in batch:
                    self.wfile.write(("event: message\ndata: " + json.dumps(m) + "\n\n").encode()); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8788), H).serve_forever()
