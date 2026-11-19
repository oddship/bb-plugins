#!/usr/bin/env python3
"""Explicit, temporary network workaround for the one retained acceptance VM."""
import json
import pathlib
import re
import socket
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
record_path = root / "verification/guest-network.json"
record = json.loads(record_path.read_text())
action = sys.argv[1] if len(sys.argv) == 2 else "show"
if action not in ("show", "apply", "remove"):
    raise SystemExit("Usage: scripts/guest-network.py show|apply|remove")
ssh = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o",
       "UserKnownHostsFile=" + str(root / "artifacts/local-services/host-known_hosts"),
       "-p", "2223", "ubuntu@127.0.0.1"]
current = subprocess.check_output(ssh + ["sudo nft -a list chain ip filter DOCKER-USER"], text=True)
tap, guest = record["tap"], record["guest"]
assert re.fullmatch(r"dvm-[a-f0-9]+", tap) and re.fullmatch(r"[0-9.]+", guest)
handles = []
for line in current.splitlines():
    if 'comment "bb-dummie-acceptance-' in line and '"' + tap + '"' in line and guest in line:
        match = re.search(r"# handle (\d+)", line)
        if match:
            handles.append(int(match.group(1)))
if action == "show":
    print(json.dumps({"tap": tap, "guest": guest, "currentOwnedHandles": handles}, indent=2))
    raise SystemExit(0)
commands = ["delete rule ip filter DOCKER-USER handle " + str(x) for x in handles]
if action == "apply":
    inspected = json.loads(subprocess.check_output(["bb", "dummie", "inspect", record["allocationKey"], "--json"], text=True))
    vm = inspected["vm"]
    assert vm and vm["id"] == record["vmId"] and "dvm-" + vm["vm_id"] == tap
    rows = subprocess.check_output(ssh + ["sudo dclient vm list"], text=True).splitlines()
    assert any(len(parts := line.split()) > 4 and parts[0] == vm["vm_id"] and parts[1] == vm["name"] and parts[4] == guest for line in rows)
    addresses = sorted({x[4][0] for host in record["destinations"] for x in socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)})
    assert addresses and len(addresses) <= 100 and all(re.fullmatch(r"[0-9.]+", x) for x in addresses)
    commands += [
        f'add rule ip filter DOCKER-USER iifname "{tap}" ip saddr {guest} ip daddr 1.1.1.1 udp dport 53 accept comment "bb-dummie-acceptance-dns"',
        f'add rule ip filter DOCKER-USER iifname "{tap}" ip saddr {guest} ip daddr {{ {", ".join(addresses)} }} tcp dport 443 accept comment "bb-dummie-acceptance-https"',
        f'add rule ip filter DOCKER-USER oifname "{tap}" ip daddr {guest} ct state established,related accept comment "bb-dummie-acceptance-return"',
    ]
if commands:
    subprocess.run(ssh + ["sudo nft -f -"], input="\n".join(commands) + "\n", text=True, check=True)
if action == "apply":
    observed = subprocess.check_output(ssh + ["sudo nft -a list chain ip filter DOCKER-USER"], text=True)
    current_handles = []
    for line in observed.splitlines():
        if 'comment "bb-dummie-acceptance-' in line and '"' + tap + '"' in line and guest in line:
            match = re.search(r"# handle (\d+)", line)
            if match:
                current_handles.append(int(match.group(1)))
    assert len(current_handles) == 3
    record["httpsAddresses"] = addresses
    record["nftHandles"] = current_handles
    record["rollback"] = ["sudo nft delete rule ip filter DOCKER-USER handle " + str(x) for x in current_handles]
    record_path.write_text(json.dumps(record, indent=2) + "\n")
print("Updated only the retained guest's temporary forwarding rules.")
