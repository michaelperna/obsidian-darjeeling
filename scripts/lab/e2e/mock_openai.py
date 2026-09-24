#!/usr/bin/env python3
"""
mock_openai.py -- Lightweight local mock for OpenAI-compatible endpoint.
Allows direct API testing in E2E runs without internet or real API keys.
"""

import json
from http.server import HTTPServer, BaseHTTPRequestHandler

class MockHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass # silent

    def do_GET(self):
        if self.path.endswith("/models"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "data": [
                    {"id": "gpt-4o", "object": "model"},
                    {"id": "mock-model", "object": "model"}
                ]
            }).encode("utf-8"))
        elif self.path.endswith("/health"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status": "ok"}')
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path.endswith("/chat/completions"):
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len > 0 else b""
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            resp = {
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "created": 1700000000,
                "model": "gpt-4o",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "Fake direct API response from mock endpoint"
                    },
                    "finish_reason": "stop"
                }],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 8,
                    "total_tokens": 18
                }
            }
            self.wfile.write(json.dumps(resp).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

def run(port=8766):
    server = HTTPServer(("127.0.0.1", port), MockHandler)
    server.serve_forever()

if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    run(port)
