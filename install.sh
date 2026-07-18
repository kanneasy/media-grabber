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
mkdir -p "$TARGET_DIR"

cat > "$TARGET" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Media Grabber native host (runs yt-dlp and whisper.cpp)",
  "path": "$RUNTIME_HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

echo "Installed native host manifest:"
echo "  $TARGET"
echo "Deployed helper (runs from here): $RUNTIME_HOST"
echo
echo "Done. No Chrome restart needed — open the popup and download."
