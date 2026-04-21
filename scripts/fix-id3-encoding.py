#!/usr/bin/env python3
"""
fix-id3-encoding.py — Re-encode Windows-1250 ID3 tags to UTF-8 (ID3v2.4)

Czech MP3 files are often tagged with Windows-1250 (Central European) encoding
but the ID3 frames declare ISO-8859-1. Characters like Š (0x8A), š (0x9A),
Ž (0x8E), ž (0x9E), etc. are control characters in ISO-8859-1 and get silently
dropped by most tag readers.

This script:
  1. Scans MP3 files for text frames containing Windows-1250 byte sequences
  2. Re-decodes the raw bytes as Windows-1250
  3. Saves them back as proper UTF-8 ID3v2.4 tags

Requirements:
  pip install mutagen

Usage:
  python3 fix-id3-encoding.py /path/to/music          # dry run (default)
  python3 fix-id3-encoding.py /path/to/music --apply   # actually write changes
"""

import sys
from pathlib import Path

from mutagen.id3 import ID3, ID3NoHeaderError
from mutagen.id3._frames import TextFrame

# Windows-1250 bytes in the 0x80-0x9F range — control characters in ISO-8859-1.
WIN1250_INDICATORS = set(range(0x80, 0xA0))

# Text frame IDs we care about
TEXT_FRAME_IDS = {
    "TIT2",  # title
    "TPE1",  # artist / performer
    "TPE2",  # album artist
    "TALB",  # album
    "TCOM",  # composer
    "TCON",  # genre
    "COMM",  # comment
    "TPE3",  # conductor
    "TPE4",  # remixer
    "TPUB",  # publisher
    "TSST",  # set subtitle
    "TIT1",  # content group
    "TIT3",  # subtitle
}


def looks_like_win1250(raw_bytes: bytes) -> bool:
    return any(b in WIN1250_INDICATORS for b in raw_bytes)


def try_fix_text(text: str) -> tuple[str, bool]:
    try:
        raw = text.encode("latin-1")
    except UnicodeEncodeError:
        return text, False

    if not looks_like_win1250(raw):
        try:
            candidate = raw.decode("cp1250")
            if candidate != text and any(ord(c) > 127 for c in candidate):
                return candidate, True
        except (UnicodeDecodeError, UnicodeEncodeError):
            pass
        return text, False

    try:
        fixed = raw.decode("cp1250")
        return fixed, True
    except UnicodeDecodeError:
        return text, False


def process_file(mp3_path: Path, apply: bool) -> list[str]:
    changes = []
    try:
        tags = ID3(str(mp3_path))
    except ID3NoHeaderError:
        return []
    except Exception as e:
        changes.append(f"  ERROR reading tags: {e}")
        return changes

    modified = False
    for frame_id in list(tags.keys()):
        base_id = frame_id.split(":")[0] if ":" in frame_id else frame_id
        if base_id not in TEXT_FRAME_IDS:
            continue
        frame = tags[frame_id]
        if not isinstance(frame, TextFrame):
            continue

        new_texts = []
        frame_changed = False
        for text_val in frame.text:
            if not isinstance(text_val, str):
                new_texts.append(text_val)
                continue
            fixed, was_fixed = try_fix_text(text_val)
            if was_fixed:
                changes.append(f"  {frame_id}: \"{text_val}\" -> \"{fixed}\"")
                frame_changed = True
                new_texts.append(fixed)
            else:
                new_texts.append(text_val)

        if frame_changed:
            frame.text = new_texts
            frame.encoding = 3  # UTF-8
            modified = True

    if modified and apply:
        tags.update_to_v24()
        tags.save(v2_version=4)

    return changes


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    root = Path(sys.argv[1])
    apply = "--apply" in sys.argv

    if not root.is_dir():
        print(f"Error: {root} is not a directory")
        sys.exit(1)

    mode = "APPLYING CHANGES" if apply else "DRY RUN (use --apply to write)"
    print(f"\n{'='*60}")
    print(f"  ID3 Encoding Fix - {mode}")
    print(f"  Scanning: {root}")
    print(f"{'='*60}\n")

    mp3_files = sorted(
        f for f in root.rglob("*") if f.suffix.lower() == ".mp3" and not f.name.startswith("._")
    )
    print(f"Found {len(mp3_files)} MP3 files\n")

    total_files_fixed = 0
    total_tags_fixed = 0

    for mp3 in mp3_files:
        changes = process_file(mp3, apply)
        if changes:
            total_files_fixed += 1
            total_tags_fixed += len([c for c in changes if not c.startswith("  ERROR")])
            rel = mp3.relative_to(root)
            print(f"  {rel}")
            for c in changes:
                print(c)
            print()

    print(f"{'='*60}")
    print(f"  Summary: {total_tags_fixed} tags in {total_files_fixed} files", end="")
    if apply:
        print(" - FIXED")
    else:
        print(" - would be fixed (run with --apply)")
    print(f"  Total scanned: {len(mp3_files)} files")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
