#!/usr/bin/env bash
set -euo pipefail

if [[ -z ${FURY_TOKEN:-} ]]; then
  echo "FURY_TOKEN is required to upload deb/rpm/apk packages to Gemfury." >&2
  exit 1
fi

directory="${1:-dist}"
if [[ ! -d $directory ]]; then
  echo "Package directory does not exist: $directory" >&2
  exit 1
fi

found=0
for pattern in '*.deb' '*.rpm' '*.apk'; do
  while IFS= read -r -d '' file; do
    found=1
    echo "Uploading $file to Gemfury..."
    curl --fail --show-error --silent -F package=@"$file" "https://${FURY_TOKEN}@push.fury.io/atomicloud/"
    echo "Uploaded $file"
  done < <(find "$directory" -type f -name "$pattern" -print0)
done

if [[ $found -eq 0 ]]; then
  echo "No deb/rpm/apk packages found under $directory." >&2
  exit 1
fi
