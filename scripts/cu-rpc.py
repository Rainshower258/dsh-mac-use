#!/usr/bin/env python3
"""Talk to a running cu-runtime daemon: hello with the token file, then one request.

    scripts/cu-rpc.py runtime.ping
    scripts/cu-rpc.py grants.set '{"task_id":"t","bundle_ids":["dev.dsh.bench.fixture"],"source":"config"}'
"""
import json
import os
import socket
import struct
import sys

STATE = os.environ.get('CU_STATE_DIR', os.path.expanduser('~/Library/Application Support/cu-runtime'))


def call(sock, rid, method, params=None):
    body = json.dumps({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params or {}}).encode()
    sock.sendall(struct.pack('<I', len(body)) + body)
    head = sock.recv(4, socket.MSG_WAITALL)
    if len(head) < 4:
        raise SystemExit('connection closed by daemon')
    (n,) = struct.unpack('<I', head)
    return json.loads(sock.recv(n, socket.MSG_WAITALL))


def main():
    method = sys.argv[1] if len(sys.argv) > 1 else 'runtime.ping'
    params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    with open(os.path.join(STATE, 'token')) as f:
        token = f.read().strip()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(os.path.join(STATE, 'daemon.sock'))
    hello = call(s, 1, 'session.hello', {'token': token})
    if 'error' in hello:
        raise SystemExit(json.dumps(hello))
    print(json.dumps(call(s, 2, method, params), ensure_ascii=False))


if __name__ == '__main__':
    main()
