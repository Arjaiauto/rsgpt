"""Corrections for facts the captions got wrong (pipeline/corrections.json), shared by the pipeline scripts.

    import corrections_lib
    CORR = corrections_lib.load()
    CORR.fix_text(text, video_id=vid, field="bio")   # the text with every matching rule applied
    CORR.fix_fields(row, ("organisation", "bio"))    # {field: corrected value} for the fields that change
    CORR.guest_key(key)                              # the guest_key a correction merged this one into

A rule applies to a row when the row's video_id is in the rule's scope.video_ids or its guest_key is the rule's
scope.guest_key, and, when the rule lists `fields`, only to those fields. Matching is on whole words and ignores case
when the rule says ignore_case. Used by 06_extract.py (before rows are written), site_stats.py (guest count) and
14_apply_corrections.py (rows already in the database), so re-running any of them keeps the corrections.
"""

import json
import re
from pathlib import Path
from urllib.parse import quote_plus

CORRECTIONS_PATH = Path(__file__).with_name("corrections.json")
# Every text field a rule can reach (guests, insights and clips).
TEXT_FIELDS = ("organisation", "role_at_episode", "bio", "linkedin_search_url", "text", "topic", "opening_line")


def linkedin_search_url(name: str, organisation: str | None) -> str:
    """The same search 12_guest_links.py auto writes: a Google search for name + organisation + LinkedIn."""
    return "https://www.google.com/search?q=" + quote_plus(f"{name} {organisation or ''} LinkedIn".replace("  ", " ").strip())


class Corrections:
    def __init__(self, data: dict):
        self.rules = []
        for r in data.get("corrections", []):
            words = r"\s+".join(re.escape(w) for w in r["wrong"].split())
            self.rules.append({
                **r, "pattern": re.compile(rf"(?<![A-Za-z]){words}(?![A-Za-z])", re.I if r.get("ignore_case") else 0),
                "videos": set(r.get("scope", {}).get("video_ids", [])), "key": r.get("scope", {}).get("guest_key"),
            })
        self.keys: dict[str, str] = data.get("guest_keys", {})

    def _applies(self, rule: dict, video_id: str | None, guest_key: str | None, field: str | None) -> bool:
        if rule.get("fields") and field not in rule["fields"]:
            return False
        return (video_id in rule["videos"]) or (guest_key is not None and guest_key == rule["key"])

    def fix_text(self, text: str | None, video_id: str | None = None, guest_key: str | None = None, field: str | None = None) -> str | None:
        if not text:
            return text
        for rule in self.rules:
            if self._applies(rule, video_id, guest_key, field):
                text = rule["pattern"].sub(rule["right"], text)
        return text

    def fix_fields(self, row: dict, fields=TEXT_FIELDS) -> dict:
        """{field: corrected value} for the fields of this row that a rule changes."""
        out = {}
        for f in fields:
            old = row.get(f)
            new = self.fix_text(old, row.get("video_id"), row.get("guest_key"), f)
            if new != old:
                out[f] = new
        return out

    def guest_key(self, key: str | None) -> str | None:
        return self.keys.get(key, key) if key else key


def load(path: Path = CORRECTIONS_PATH) -> Corrections:
    return Corrections(json.loads(path.read_text(encoding="utf-8")) if path.exists() else {})
