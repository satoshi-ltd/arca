#!/usr/bin/env python3
"""Read-only host status bridge for an Arca container. Never exports keys or users."""
import argparse
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--once', action='store_true')
args = parser.parse_args()
target = Path(args.output)
target.parent.mkdir(parents=True, exist_ok=True)

def publish():
    result = subprocess.run(['/usr/bin/tailscale', 'status', '--json'], capture_output=True, text=True, timeout=8, check=True)
    status = json.loads(result.stdout)
    fields = ('ID', 'HostName', 'DNSName', 'OS', 'TailscaleIPs', 'Online')
    clean = lambda node: {key: node[key] for key in fields if key in node}
    value = {'BackendState': status.get('BackendState'), 'Self': clean(status.get('Self', {})), 'Peer': {str(i): clean(p) for i, p in enumerate(status.get('Peer', {}).values())}}
    fd, name = tempfile.mkstemp(dir=target.parent, prefix='.status-')
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, target)
    finally:
        if os.path.exists(name): os.unlink(name)

while True:
    try:
        publish()
    except Exception:
        # Existing status expires in Arca after 90 seconds. Do not retain a false online state.
        print('Tailscale status unavailable; the previous snapshot will expire.', flush=True)
        if args.once: raise SystemExit(1)
    if args.once: break
    time.sleep(15)
