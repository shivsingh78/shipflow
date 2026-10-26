#!/bin/sh
# Starts dockerd (unix socket only), then publishes the host key and a deploy
# key pair through the /keys volume and runs sshd. Test-only keys.
set -eu

dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock >/var/log/dockerd.log 2>&1 &

i=0
until docker info >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "dockerd did not start" >&2
    tail -n 50 /var/log/dockerd.log >&2
    exit 1
  fi
  sleep 1
done

ssh-keygen -A >/dev/null
mkdir -p /keys

if [ ! -f /keys/deploy_key ]; then
  ssh-keygen -q -t ed25519 -N "" -C shipflow-e2e-dockerhost -f /keys/deploy_key
fi

install -d -m 700 -o deploy -g docker /home/deploy/.ssh
install -m 600 -o deploy -g docker /keys/deploy_key.pub /home/deploy/.ssh/authorized_keys
cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub > /keys/host_key.pub
chmod 644 /keys/deploy_key /keys/host_key.pub

touch /keys/ready
exec /usr/sbin/sshd -D -e
