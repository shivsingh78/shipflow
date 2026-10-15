#!/bin/sh
# Generates the server host key and a deploy key pair at start-up and shares
# the public host key and the deploy private key with the e2e runner through
# the /keys volume. Test-only keys; nothing is committed.
set -eu

ssh-keygen -A >/dev/null
mkdir -p /keys

if [ ! -f /keys/deploy_key ]; then
  ssh-keygen -q -t ed25519 -N "" -C shipflow-e2e -f /keys/deploy_key
fi

install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
install -m 600 -o deploy -g deploy /keys/deploy_key.pub /home/deploy/.ssh/authorized_keys
cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub > /keys/host_key.pub
# The runner container reads these as a different user (test-only keys).
chmod 644 /keys/deploy_key /keys/host_key.pub

nginx
touch /keys/ready
exec /usr/sbin/sshd -D -e
