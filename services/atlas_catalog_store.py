"""Read immutable Atlas generations through a single, atomically published manifest.

A view pins the manifest for a complete operation. Historical generations and the
legacy corpus are deliberately separate from the active search catalog.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TERM_PATTERN = re.compile(r"^[A-Za-z]+_\d{4}$")
SEASON_ORDER = {"Spring": 1, "Summer": 2, "Fall": 3, "Winter": 4}


def term_sort_key(term):
    season, year = term.rsplit("_", 1)
    return int(year), SEASON_ORDER.get(season, 0), term


def safe_component(value):
    return isinstance(value, str) and bool(value) and value not in {".", ".."} and not any(c in value for c in ("/", "\\", "\x00"))


def _read_document(path):
    try:
        raw = path.read_bytes()
        document = json.loads(raw)
        if not isinstance(document, dict):
            return {}, raw
        return document, raw
    except (OSError, ValueError):
        return {}, b""


class CatalogStore:
    def __init__(self, root=PROJECT_ROOT):
        self.root = Path(root).resolve()

    def view(self):
        return CatalogView(self.root)


class CatalogView:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.atlas_root = self.root / "data" / "atlas"
        self.manifest, manifest_bytes = _read_document(self.atlas_root / "manifest.json")
        self.registry, registry_bytes = _read_document(self.atlas_root / "registry.json")
        # An alternate data root (used by callers/tests) still uses the shared
        # registry for known live Atlas IDs, never for catalog availability.
        if not self.registry and self.root != PROJECT_ROOT:
            self.registry, registry_bytes = _read_document(PROJECT_ROOT / "data" / "atlas" / "registry.json")
        self.cache_token = (str(self.root), hashlib.sha256(manifest_bytes + b"\0" + registry_bytes).hexdigest())
        self._terms = None

    def _records(self, document):
        terms = document.get("terms", {})
        return terms if isinstance(terms, dict) else {}

    def _record(self, term):
        record = self._records(self.manifest).get(term, {})
        return record if isinstance(record, dict) else {}

    def _snapshot_path(self, term, record):
        if not TERM_PATTERN.fullmatch(str(term)) or not isinstance(record, dict):
            return None
        generation = record.get("generation")
        if not safe_component(generation):
            return None
        relative = f"snapshots/{term}/{generation}"
        expected = self.atlas_root / relative
        # Do not accept paths that select another term, or escape the store.
        try:
            if record.get("path", relative) != relative:
                return None
            path = expected
            if path.resolve() != expected.absolute() or not path.resolve().is_relative_to(self.atlas_root):
                return None
        except (OSError, ValueError, TypeError, RuntimeError):
            return None
        return path if path.is_dir() else None

    def _legacy_path(self, term):
        if not TERM_PATTERN.fullmatch(str(term)):
            return None
        path = self.root / term
        try:
            return path if path.is_dir() and path.resolve().is_relative_to(self.root) else None
        except (OSError, ValueError, RuntimeError):
            return None

    def current_path(self, term):
        if not TERM_PATTERN.fullmatch(str(term)):
            return None
        record = self._record(term)
        if record.get("status") == "complete":
            published = self._snapshot_path(term, record)
            # A completed empty roster is authoritative too: falling back would
            # bring courses removed by the latest refresh back into search.
            if published is not None:
                return published
        return self._legacy_path(term)

    def history_paths(self, term):
        current = self.current_path(term)
        paths = [current] if current is not None else []
        record = self._record(term)
        previous_generations = record.get("previous_generations", [])
        if not isinstance(previous_generations, list):
            previous_generations = []
        for previous in previous_generations:
            if isinstance(previous, str):
                previous = {"generation": previous}
            path = self._snapshot_path(term, previous)
            if path is not None and path not in paths:
                paths.append(path)
        legacy = self._legacy_path(term)
        if legacy is not None and legacy not in paths:
            paths.append(legacy)
        return paths

    def terms(self):
        if self._terms is None:
            legacy = {path.name for path in self.root.iterdir() if path.is_dir() and TERM_PATTERN.fullmatch(path.name)} if self.root.is_dir() else set()
            candidates = legacy | set(self._records(self.manifest))
            self._terms = sorted((term for term in candidates if self.current_path(term) is not None), key=term_sort_key, reverse=True)
        return list(self._terms)

    def srcdb(self, term):
        manifest = self._record(term)
        registry = self._records(self.registry).get(term, {})
        value = manifest.get("srcdb") or (registry.get("srcdb") if isinstance(registry, dict) else None)
        return str(value) if value else None

    def term_metadata(self):
        result = {}
        for term in set(self.terms()) | set(self._records(self.registry)) | set(self._records(self.manifest)):
            if not TERM_PATTERN.fullmatch(str(term)):
                continue
            record = self._record(term)
            registry = self._records(self.registry).get(term, {})
            registry = registry if isinstance(registry, dict) else {}
            current = self.current_path(term)
            published_path = self._snapshot_path(term, record)
            published = record.get("status") == "complete" and published_path is not None and current == published_path
            result[term] = {
                "label": record.get("label") or registry.get("label") or term.replace("_", " "),
                "srcdb": self.srcdb(term),
                "status": "complete" if published else "legacy/unverified" if current else "unavailable",
                "generation": record.get("generation") if published else None,
                "last_successful_refresh": record.get("last_successful_refresh") if published else None,
                "coverage": record.get("coverage", {}) if published else {},
                "tentative": record.get("tentative", registry.get("tentative", False)) is True,
                "notice": record.get("notice") or registry.get("notice"),
            }
        return result

    def course_paths(self, term, subject, catalog, *, include_history=False):
        if not all(safe_component(value) for value in (term, subject, catalog)):
            return []
        roots = self.history_paths(term) if include_history else [self.current_path(term)]
        paths = []
        for root in roots:
            if root is None:
                continue
            path = root / subject.upper() / f"{catalog}.json"
            try:
                if path.resolve().is_relative_to(root.resolve()) and path.is_file():
                    paths.append(path)
            except (OSError, ValueError, RuntimeError):
                continue
        return paths
