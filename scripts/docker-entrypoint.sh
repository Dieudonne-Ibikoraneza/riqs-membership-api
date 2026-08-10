#!/bin/sh
set -eu

# Keep the backend image immutable. Runtime state belongs in /tmp; database
# migrations remain an explicit deployment operation.
exec "$@"
