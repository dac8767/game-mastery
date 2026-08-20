#!/usr/bin/env bash
#
# make-webres.sh — mirror a battle map library into web-resolution WebP.
#
# Usage:   ./make-webres.sh /mnt/Media/game-mastery/maps /mnt/Media/game-mastery/maps-web
#
# - Preserves the directory structure (so tags/paths stay meaningful)
# - Incremental: skips files whose output already exists and is newer
#   than the source, so re-running after adding maps is cheap
# - Converts jpg/jpeg/png/webp/tif/tiff; copies anything else untouched
#   (e.g. .dd2vtt / .uvtt module files players may need verbatim)
# - Caps the long edge at MAX_EDGE px; originals smaller than that are
#   just re-encoded, never upscaled
#
# Requires: imagemagick, webp  (sudo apt install imagemagick webp)

set -euo pipefail

SRC="${1:?Usage: make-webres.sh <source_dir> <dest_dir>}"
DEST="${2:?Usage: make-webres.sh <source_dir> <dest_dir>}"

MAX_EDGE=2560   # long-edge pixel cap for display copies
QUALITY=80      # WebP quality; 80 is visually clean for VTT use

converted=0
skipped=0
copied=0

echo "Mirroring: $SRC -> $DEST (max edge ${MAX_EDGE}px, q${QUALITY})"

find "$SRC" -type f | while IFS= read -r file; do
	rel="${file#"$SRC"/}"
	ext="${file##*.}"
	ext_lower="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"

	case "$ext_lower" in
		jpg|jpeg|png|webp|tif|tiff)
			out="$DEST/${rel%.*}.webp"
			mkdir -p "$(dirname "$out")"
			# Skip if output exists and is newer than the source
			if [[ -f "$out" && "$out" -nt "$file" ]]; then
				skipped=$((skipped + 1))
				continue
			fi
			# Resize only if larger than MAX_EDGE (the > flag), encode WebP
			magick "$file" -resize "${MAX_EDGE}x${MAX_EDGE}>" \
				-quality "$QUALITY" "$out"
			converted=$((converted + 1))
			echo "  converted: $rel"
			;;
		*)
			out="$DEST/$rel"
			mkdir -p "$(dirname "$out")"
			if [[ -f "$out" && "$out" -nt "$file" ]]; then
				skipped=$((skipped + 1))
				continue
			fi
			cp -p "$file" "$out"
			copied=$((copied + 1))
			echo "  copied:    $rel"
			;;
	esac
done

echo "Done. Converted: $converted, copied: $copied, skipped (up to date): $skipped"
