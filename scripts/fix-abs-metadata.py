#!/usr/bin/env python3
"""
fix-abs-metadata.py — Fix corrupted Audiobookshelf metadata using folder names.

ABS caches metadata from ID3 tags on first scan. If the tags had encoding issues
(e.g. Windows-1250 read as ISO-8859-1), the cached metadata stays corrupted even
after the tags are fixed and the library is re-scanned.

This script reads the correct data from the folder-name-derived 'subtitle' field
and patches the ABS database via the API.

Usage:
  python3 fix-abs-metadata.py                    # dry run
  python3 fix-abs-metadata.py --apply             # write changes
  python3 fix-abs-metadata.py --library NAME      # target specific library (default: Audioknihy)
"""

import json
import os
import sqlite3
import sys
import urllib.request

# ── Config ────────────────────────────────────────────────────────────────────

DB_PATHS = [
    os.path.expanduser("~/dev/Talome/apps/core/data/talome.db"),
    os.path.expanduser("~/dev/Talome/data/talome.db"),
]

CORRUPTION_CHARS = set("\u00f8\u00f9\u00ec\u00e8\u00e9\u00c8\u00d8")  # ø ù ì è é È Ø


def get_abs_config():
    for db_path in DB_PATHS:
        if not os.path.exists(db_path) or os.path.getsize(db_path) == 0:
            continue
        db = sqlite3.connect(db_path)
        db.row_factory = sqlite3.Row
        rows = db.execute(
            "SELECT key, value FROM settings WHERE key IN ('audiobookshelf_url', 'audiobookshelf_api_key')"
        ).fetchall()
        db.close()
        config = {r["key"]: r["value"] for r in rows}
        base = config.get("audiobookshelf_url", "").strip().strip('"').rstrip("/")
        token = config.get("audiobookshelf_api_key", "").strip().strip('"')
        if base and token:
            return base, token
    print("ERROR: Could not find audiobookshelf_url / audiobookshelf_api_key in Talome DB")
    print(f"  Searched: {DB_PATHS}")
    sys.exit(1)


def abs_get(base, token, path):
    req = urllib.request.Request(
        f"{base}{path}",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def abs_patch(base, token, path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{base}{path}",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="PATCH",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def looks_corrupted(text: str) -> bool:
    for ch in text:
        if ch in CORRUPTION_CHARS:
            return True
        if 0x80 <= ord(ch) <= 0x9F:
            return True
    return False


def parse_folder_metadata(rel_path: str):
    folder = rel_path.rsplit("/", 1)[-1] if "/" in rel_path else rel_path
    parts = folder.split(" - ", 2)

    if len(parts) >= 3:
        title = parts[1].strip()
        cast = [n.strip() for n in parts[2].split(",") if n.strip()]
        return title, cast
    elif len(parts) == 2:
        return parts[1].strip(), []

    return None, []


def find_library(base, token, name):
    data = abs_get(base, token, "/api/libraries")
    for lib in data.get("libraries", []):
        if lib["name"].lower() == name.lower():
            return lib["id"]
    names = [lib["name"] for lib in data.get("libraries", [])]
    print(f"ERROR: Library '{name}' not found. Available: {names}")
    sys.exit(1)


def main():
    apply = "--apply" in sys.argv
    lib_name = "Audioknihy"
    if "--library" in sys.argv:
        idx = sys.argv.index("--library")
        if idx + 1 < len(sys.argv):
            lib_name = sys.argv[idx + 1]

    base, token = get_abs_config()
    library_id = find_library(base, token, lib_name)

    mode = "APPLYING" if apply else "DRY RUN (use --apply to write)"
    print(f"\n{'='*60}")
    print(f"  ABS Metadata Fix - {mode}")
    print(f"  Library: {lib_name} ({library_id})")
    print(f"{'='*60}\n")

    page = 0
    all_items = []
    while True:
        data = abs_get(base, token, f"/api/libraries/{library_id}/items?limit=50&page={page}&expanded=1")
        results = data.get("results", [])
        if not results:
            break
        all_items.extend(results)
        page += 1
        if len(all_items) >= data.get("total", 0):
            break

    print(f"Fetched {len(all_items)} items\n")

    fixed = 0
    for item in all_items:
        item_id = item["id"]
        media = item.get("media", {})
        metadata = media.get("metadata", {})

        current_title = metadata.get("title", "")
        current_author = metadata.get("authorName", "")
        rel_path = item.get("relPath", "")

        title_bad = looks_corrupted(current_title)
        author_bad = looks_corrupted(current_author)

        if not title_bad and not author_bad:
            continue

        correct_title, correct_authors = parse_folder_metadata(rel_path)
        if not correct_title:
            continue

        patch = {"metadata": {}}
        if title_bad and correct_title != current_title:
            patch["metadata"]["title"] = correct_title
        if author_bad and correct_authors:
            patch["metadata"]["authors"] = [{"name": n} for n in correct_authors]

        if not patch["metadata"]:
            continue

        print(f"  {current_title}")
        if "title" in patch["metadata"]:
            print(f"    Title: \"{current_title}\" -> \"{patch['metadata']['title']}\"")
        if "authors" in patch["metadata"]:
            names = ", ".join(a["name"] for a in patch["metadata"]["authors"])
            print(f"    Authors: \"{current_author}\"")
            print(f"          -> \"{names}\"")
        print()

        if apply:
            try:
                abs_patch(base, token, f"/api/items/{item_id}/media", patch)
                fixed += 1
            except Exception as e:
                print(f"    ERROR: {e}\n")
        else:
            fixed += 1

    print(f"{'='*60}")
    print(f"  {fixed} items {'fixed' if apply else 'would be fixed'}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
