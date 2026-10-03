#!/usr/bin/env bash
#
# make-webres.sh — mirror a battle map library into web-resolution WebP.
#
# Usage:   ./make-webres.sh /mnt/Media/game-mastery/maps /mnt/Media/game-mastery/maps-web
#
# - Preserves the directory structure (so tags/paths stay meaningful)
# - Incremental: skips files whose output already exists, so re-running
#   after adding maps is cheap
# - Converts jpg/jpeg/png/webp/tif/tiff; copies anything else untouched
#   (e.g. .dd2vtt / .uvtt module files players may need verbatim)
# - Caps the long edge at MAX_EDGE px; originals smaller than that are
#   just re-encoded, never upscaled
#
# Never overwrites. Caddy serves /web with `Cache-Control: immutable`, so
# a browser that has seen a URL never asks for it again — replacing the
# file behind it would leave every player who already loaded the map
# looking at the old one, indefinitely. A source edited since its copy
# was made is reported as CHANGED and left alone; the convention is to
# save a revision under a new filename (see HANDOFF.md). To deliberately
# rebuild one copy anyway, delete it from the destination and re-run.
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
changed=0

echo "Mirroring: $SRC -> $DEST (max edge ${MAX_EDGE}px, q${QUALITY})"

# Fed from process substitution, not a pipe: `find | while` runs the loop
# in a subshell, so every counter it increments is thrown away and the
# summary always printed zeros. NUL-separated so any filename works.
while IFS= read -r -d '' file; do
	rel="${file#"$SRC"/}"
	ext="${file##*.}"
	ext_lower="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"

	case "$ext_lower" in
		jpg|jpeg|png|webp|tif|tiff) out="$DEST/${rel%.*}.webp" ;;
		*) out="$DEST/$rel" ;;
	esac

	if [[ -e "$out" ]]; then
		if [[ "$file" -nt "$out" ]]; then
			changed=$((changed + 1))
			echo "  CHANGED (not overwritten — save it under a new name): $rel"
		else
			skipped=$((skipped + 1))
		fi
		continue
	fi

	mkdir -p "$(dirname "$out")"
	# Written beside the destination and renamed into place, so an
	# interrupted run never leaves a half-written file at a URL that
	# browsers will then cache for good.
	tmp="$(dirname "$out")/.partial.$$.$(basename "$out")"
	trap 'rm -f "$tmp"' EXIT

	case "$ext_lower" in
		jpg|jpeg|png|webp|tif|tiff)
			# Resize only if larger than MAX_EDGE (the > flag), encode WebP
			magick "$file" -resize "${MAX_EDGE}x${MAX_EDGE}>" \
				-quality "$QUALITY" "webp:$tmp"
			mv "$tmp" "$out"
			converted=$((converted + 1))
			echo "  converted: $rel"
			;;
		*)
			cp -p "$file" "$tmp"
			mv "$tmp" "$out"
			copied=$((copied + 1))
			echo "  copied:    $rel"
			;;
	esac
	trap - EXIT
done < <(find "$SRC" -type f -print0)

echo "Done. Converted: $converted, copied: $copied, skipped (up to date): $skipped, changed (left alone): $changed"
