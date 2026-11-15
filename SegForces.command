#!/bin/bash
# Double-click in Finder to start SegForces and open it in the browser.
cd "$(dirname "$0")" || exit 1
exec /usr/bin/env python3 server.py --open "$@"
