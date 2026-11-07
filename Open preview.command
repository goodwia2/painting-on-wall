#!/bin/bash
# Double-click to preview the page on this Mac.
cd "$(dirname "$0")"
PORT=8123
(sleep 1; open "http://localhost:$PORT") &
echo "Previewing at http://localhost:$PORT  (close this window to stop)"
python3 -m http.server $PORT
