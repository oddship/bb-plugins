#!/usr/bin/env python3
"""Keep a loopback-only Codex proxy tunnel while its BB machine exists."""
import argparse
import json
import signal
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--bb', required=True)
parser.add_argument('--node', required=True)
parser.add_argument('--ssh', required=True)
parser.add_argument('--host', required=True)
parser.add_argument('--vm', required=True)
parser.add_argument('--proxy', required=True)
parser.add_argument('--identity', required=True)
parser.add_argument('--known-hosts', required=True)
parser.add_argument('--remote-port', type=int, default=18317)
parser.add_argument('--local-port', type=int, default=8317)
args = parser.parse_args()
for port in [args.remote_port, args.local_port]:
    if not 1 <= port <= 65535:
        parser.error('Ports must be between 1 and 65535.')
child = None
stopping = False


def stop(*_):
    global stopping
    stopping = True
    if child and child.poll() is None:
        child.terminate()


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)


def machine_state():
    result = subprocess.run([args.node, args.bb, 'machine', 'show', args.host, '--json'],
                            capture_output=True, text=True, timeout=20)
    if result.returncode:
        error = json.loads(result.stdout).get('error', {}) if result.stdout.strip().startswith('{') else {}
        if any(term in str(error).lower() for term in ['not found', 'unknown machine', 'unknown host']):
            return 'gone'
        return 'wait'
    phase = json.loads(result.stdout).get('lifecycle', {}).get('phase')
    if phase in ['retiring', 'removed']:
        return 'gone'
    return 'active' if phase == 'active' else 'wait'


try:
    while not stopping:
        state = machine_state()
        if state == 'gone':
            print('VM removed; closing its Codex account connection.', flush=True)
            break
        if state == 'active' and (child is None or child.poll() is not None):
            child = subprocess.Popen([
                args.ssh, '-F', '/dev/null', '-i', args.identity, '-NT',
                '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
                '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + args.known_hosts,
                '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
                '-o', 'ExitOnForwardFailure=yes',
                '-R', f'127.0.0.1:{args.remote_port}:127.0.0.1:{args.local_port}',
                args.vm + '@' + args.proxy,
            ], stdin=subprocess.DEVNULL)
        if state == 'wait' and child is not None and child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
        for _ in range(15):
            if stopping:
                break
            time.sleep(1)
finally:
    if child is not None and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
