#!/usr/bin/env bash
# Registers the Media Grabber native-messaging host with Chrome.
# Run AFTER loading extension/ unpacked at chrome://extensions (you need its ID).
set -euo pipefail

EXT_ID="${1:-}"
if [[ -z "$EXT_ID" ]]; then
  echo "Usage: ./install.sh <chrome-extension-id>"
  echo
  echo "  1. Go to chrome://extensions, enable Developer mode."
  echo "  2. 'Load unpacked' -> select the extension/ folder."
  echo "  3. Copy the extension's ID (32 letters) and pass it here."
  exit 1
fi
if ! [[ "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Warning: '$EXT_ID' doesn't look like a 32-char Chrome extension ID (a-p). Continuing anyway."
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_HOST="$DIR/host/host.py"
HOST_NAME="com.cleric.mediagrabber"
TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
TARGET="$TARGET_DIR/$HOST_NAME.json"

# The helper must NOT run from ~/Documents: macOS TCC blocks Chrome from
# executing scripts in Documents/Desktop/Downloads. Deploy it under
# ~/Library/Application Support (not TCC-protected). This is a COPY — re-run
# install.sh after editing host/host.py to redeploy.
RUNTIME_DIR="$HOME/Library/Application Support/MediaGrabber"
RUNTIME_HOST="$RUNTIME_DIR/host.py"

if [[ ! -f "$SRC_HOST" ]]; then
  echo "Error: host script not found at $SRC_HOST"
  exit 1
fi

# Sanity-check the tools the host depends on (absolute paths, Chrome has no PATH).
for bin in /opt/homebrew/bin/yt-dlp /opt/homebrew/bin/ffmpeg /opt/homebrew/bin/python3; do
  [[ -x "$bin" ]] || echo "Warning: $bin not found/executable — the host needs it."
done

# --- Whisper (local transcription) -------------------------------------------
# Optional: downloads only stop working if yt-dlp/ffmpeg are missing, so a
# missing whisper is a warning rather than a hard failure.
WHISPER_BIN="/opt/homebrew/bin/whisper-cli"
MODEL_NAME="${MODEL_NAME:-small.en}"
MODEL_DIR="$HOME/Library/Application Support/MediaGrabber/models"
MODEL_PATH="$MODEL_DIR/ggml-$MODEL_NAME.bin"

if [[ ! -x "$WHISPER_BIN" ]]; then
  echo "Warning: $WHISPER_BIN not found — transcription will be unavailable."
  echo "         Install it with: brew install whisper-cpp"
elif [[ ! -f "$MODEL_PATH" ]]; then
  echo "Downloading whisper model '$MODEL_NAME' (~466 MB for small.en)…"
  mkdir -p "$MODEL_DIR"
  # -f so a 404 fails loudly instead of writing an HTML error page as the model.
  if curl -fL --progress-bar -o "$MODEL_PATH.part" \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL_NAME.bin"; then
    mv "$MODEL_PATH.part" "$MODEL_PATH"
    echo "Model installed: $MODEL_PATH"
  else
    rm -f "$MODEL_PATH.part"
    echo "Warning: model download failed — transcription will be unavailable."
  fi
else
  echo "Whisper model present: $MODEL_PATH"
fi

mkdir -p "$RUNTIME_DIR"
cp "$SRC_HOST" "$RUNTIME_HOST"
chmod +x "$RUNTIME_HOST"

# Build the manifest once, then install it into every NativeMessagingHosts dir
# Chrome might read from (see below). Keep this in sync with the fields Chrome
# requires: name, path, type, allowed_origins.
MANIFEST_JSON=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Media Grabber native host (runs yt-dlp and whisper.cpp)",
  "path": "$RUNTIME_HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

install_manifest() { # $1 = a NativeMessagingHosts directory
  mkdir -p "$1"
  printf '%s\n' "$MANIFEST_JSON" > "$1/$HOST_NAME.json"
}

# 1) The default profile's location (the normal case).
install_manifest "$TARGET_DIR"
echo "Installed native host manifest:"
echo "  $TARGET"

# 2) Custom user-data-dirs. On macOS, Chrome looks for native-host manifests
#    INSIDE its --user-data-dir, so a dev/debug Chrome started with
#    --user-data-dir=/some/path won't see the manifest above (that's only the
#    DEFAULT profile's dir) and reports "Specified native messaging host not
#    found." We register there too: (a) any Chrome currently running with a
#    custom --user-data-dir, plus (b) any dirs named in $MG_EXTRA_USER_DATA_DIRS
#    (newline-separated) for profiles that aren't running yet.
DEFAULT_UDD="$HOME/Library/Application Support/Google/Chrome"
{
  ps -Ao command= 2>/dev/null \
    | grep -F 'Google Chrome.app/Contents/MacOS/Google Chrome' \
    | grep -v -- '--type=' \
    | perl -ne 'print "$1\n" while /--user-data-dir=(.+?)(?= --|$)/g' \
    | sed 's/[[:space:]]*$//'
  printf '%s\n' "${MG_EXTRA_USER_DATA_DIRS:-}"
} | sort -u | while IFS= read -r udd; do
  [[ -z "$udd" ]] && continue
  [[ "$udd" == "$DEFAULT_UDD" ]] && continue   # same as $TARGET_DIR, already done
  install_manifest "$udd/NativeMessagingHosts"
  echo "  also registered for custom profile: $udd/NativeMessagingHosts"
done

echo "Deployed helper (runs from here): $RUNTIME_HOST"
echo
echo "Done. No Chrome restart needed — open the popup and download."
echo "(Using a custom Chrome profile that wasn't running? Re-run with"
echo " MG_EXTRA_USER_DATA_DIRS=\"/path/to/user-data-dir\" ./install.sh $EXT_ID)"
