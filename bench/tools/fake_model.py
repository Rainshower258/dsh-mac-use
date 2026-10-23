#!/usr/bin/env python3
"""A scripted stand-in for the DeepSeek chat-completions endpoint, for checks that must never reach a real model
(host-side checks of the everyday dsh set-up, e.g. the plugin's `exclusive` setting, 2026-10-03). Listens on
127.0.0.1 only, on a random port (written to --port-file). Every request is logged (path, model, the tool names it
offered: the ground truth of what the model could see). The script is fixed and side-effect free: to a user message
it answers by calling cu_list_apps with no arguments; after a tool result, with plain text. It never calls bash or
any other tool.
"""
import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCRIPTED_TOOL = 'cu_list_apps'


def sse(obj):
    return f'data: {json.dumps(obj)}\n\n'.encode()


class Handler(BaseHTTPRequestHandler):
    log_path = None
    lock = threading.Lock()

    def log_message(self, *args):
        pass

    def record(self, entry):
        with self.lock, open(self.log_path, 'a') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    def do_GET(self):
        self.record({'method': 'GET', 'path': self.path})
        self.send_error(404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
        msgs = body.get('messages', [])
        tools = sorted(t['function']['name'] for t in body.get('tools', []))
        results = [m.get('content') for m in msgs if m.get('role') == 'tool']
        self.record({'method': 'POST', 'path': self.path, 'model': body.get('model'), 'tools': tools,
                     'tool_results': results, 'auth_is_fake': self.headers.get('authorization', '').endswith('fake-not-a-key')})
        if not self.path.endswith('/chat/completions'):
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        base = {'id': 'fake', 'object': 'chat.completion.chunk', 'model': body.get('model')}
        if msgs and msgs[-1].get('role') == 'user':
            call = {'index': 0, 'id': 'call_fake_1', 'type': 'function',
                    'function': {'name': SCRIPTED_TOOL, 'arguments': '{}'}}
            self.wfile.write(sse({**base, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'tool_calls': [call]}}]}))
            self.wfile.write(sse({**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}]}))
        else:
            self.wfile.write(sse({**base, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'done'}}]}))
            self.wfile.write(sse({**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]}))
        self.wfile.write(sse({**base, 'choices': [], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}))
        self.wfile.write(b'data: [DONE]\n\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--log', required=True)
    ap.add_argument('--port-file', required=True)
    a = ap.parse_args()
    Handler.log_path = a.log
    srv = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    with open(a.port_file, 'w') as f:
        f.write(str(srv.server_address[1]))
    srv.serve_forever()


if __name__ == '__main__':
    main()
