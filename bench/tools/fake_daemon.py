#!/usr/bin/env python3
"""A capability-free stand-in for the cu-runtime daemon's socket (same framing and token handshake). It logs every
frame it receives and refuses every method with no_grant: it can see nothing and do nothing. Used where starting the
real daemon would trigger the system's permission prompts (its start-up prewarm touches ScreenCaptureKit), e.g. the
host-side exclusive check (PLAN-v2, 交接 ⑤). Its log is the "audit": a call that never arrives was stopped earlier.
"""
import argparse
import json
import os
import socket
import struct
import threading


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--state-dir', required=True)
    ap.add_argument('--log', required=True)
    a = ap.parse_args()
    os.makedirs(a.state_dir, mode=0o700, exist_ok=True)
    token = os.urandom(16).hex()
    with open(os.path.join(a.state_dir, 'token'), 'w') as f:
        f.write(token)
    path = os.path.join(a.state_dir, 'daemon.sock')
    if os.path.exists(path):
        os.unlink(path)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    os.chmod(path, 0o600)
    srv.listen(4)
    lock = threading.Lock()

    def serve(c):
        buf = b''
        while True:
            chunk = c.recv(65536)
            if not chunk:
                return
            buf += chunk
            while len(buf) >= 4 and len(buf) >= 4 + struct.unpack('<I', buf[:4])[0]:
                n = struct.unpack('<I', buf[:4])[0]
                msg, buf = json.loads(buf[4:4 + n]), buf[4 + n:]
                with lock, open(a.log, 'a') as f:
                    f.write(json.dumps({'method': msg.get('method'), 'params': msg.get('params')}) + '\n')
                if msg.get('method') == 'session.hello':
                    ok = (msg.get('params') or {}).get('token') == token
                    out = {'result': {'protocol': 'fake'}} if ok else {'error': {'code': -32001, 'message': 'bad token'}}
                else:
                    out = {'error': {'code': -32010, 'message': 'fake daemon: no grant',
                                     'data': {'reason': 'no_grant', 'retry': 'never', 'executed': False}}}
                body = json.dumps({'jsonrpc': '2.0', 'id': msg.get('id'), **out}).encode()
                c.sendall(struct.pack('<I', len(body)) + body)

    while True:
        c, _ = srv.accept()
        threading.Thread(target=serve, args=(c,), daemon=True).start()


if __name__ == '__main__':
    main()
