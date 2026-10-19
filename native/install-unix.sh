#!/bin/sh
# Installs the One Thing At A Time native file writer for Firefox (macOS / Linux, current user).
# Note: Snap / Flatpak builds of Firefox sandbox native messaging; use Firefox from mozilla.org or your distro package.
set -eu

NAME=one_thing_at_a_time
EXT_ID=one-thing-at-a-time@otaat
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/one-thing-at-a-time"

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "python3 was not found. Install Python 3 and run this again." >&2
  exit 1
fi

mkdir -p "$DEST"
cp "$SRC/otaat_host.py" "$DEST/otaat_host.py"
cat > "$DEST/otaat_host.sh" <<EOF
#!/bin/sh
exec "$PY" -I -u "$DEST/otaat_host.py" "\$@"
EOF
chmod +x "$DEST/otaat_host.sh" "$DEST/otaat_host.py"

case "$(uname -s)" in
  Darwin) MDIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
  *) MDIR="$HOME/.mozilla/native-messaging-hosts" ;;
esac
mkdir -p "$MDIR"
cat > "$MDIR/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "One Thing At A Time - writes your feed logs to plain files",
  "path": "$DEST/otaat_host.sh",
  "type": "stdio",
  "allowed_extensions": ["$EXT_ID"]
}
EOF

echo "Installed. Host: $DEST/otaat_host.sh"
echo "Manifest: $MDIR/$NAME.json"
echo "In Firefox, open the extension's Settings and press 'Check native writer'."
