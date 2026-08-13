#!/usr/bin/env bash
# Extract a non-uniform frame sample from one sabre touch, anchored on the box light.
#
#   ./extract-frames.sh <clip.mp4> <light_time_seconds> <touch_id>
#
# Example:  ./extract-frames.sh clips/bout1.mp4 74.312 t017
#
# Sampling is dense in the 400 ms before the light and sparse in the approach, because
# that is where the decision lives. Frames land in frames/<touch_id>/ named by their
# offset in ms relative to the light, so the filename IS the label the prompt reads.

set -euo pipefail

CLIP="${1:?usage: extract-frames.sh <clip> <light_time_sec> <touch_id>}"
LIGHT="${2:?missing light time in seconds}"
TOUCH="${3:?missing touch id}"

OUTDIR="frames/${TOUCH}"
mkdir -p "$OUTDIR"

# Offsets in ms relative to the light. Negative = before.
OFFSETS=(-2000 -1600 -1300 -1100 -950 -800 -700 -600 -520 -440 \
          -380  -320  -260  -200 -150 -110  -70  -35    0   60)

# Long edge 768px keeps vision token cost sane without losing blade legibility.
SCALE="scale='if(gt(iw,ih),768,-2)':'if(gt(iw,ih),-2,768)'"

for OFF in "${OFFSETS[@]}"; do
  T=$(awk -v l="$LIGHT" -v o="$OFF" 'BEGIN{printf "%.4f", l + (o/1000.0)}')
  if awk -v t="$T" 'BEGIN{exit !(t < 0)}'; then
    echo "skip ${OFF}ms (before clip start)" >&2
    continue
  fi
  NAME=$(printf "%+05d" "$OFF")
  ffmpeg -nostdin -loglevel error -y \
    -ss "$T" -i "$CLIP" \
    -frames:v 1 -vf "$SCALE" -q:v 4 \
    "${OUTDIR}/${NAME}ms.jpg"
done

echo "wrote $(ls -1 "$OUTDIR" | wc -l | tr -d ' ') frames to ${OUTDIR}"
echo "Eyeball them before spending a run: the light should be visible in +0060ms.jpg"
