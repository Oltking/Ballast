#!/usr/bin/env bash
# Verify the WSL-native Docker daemon is up (run as root).
for i in $(seq 1 15); do
  if docker info >/dev/null 2>&1; then break; fi
  sleep 2
done
echo "=== docker version ==="
docker version --format 'client {{.Client.Version}} / server {{.Server.Version}}' 2>&1 | head -2
echo "=== hello-world ==="
docker run --rm hello-world 2>&1 | grep -iE 'hello from|error|cannot|denied' | head -5
echo "DOCKER_CHECK_DONE"
