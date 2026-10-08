"""Read public HTML summary data only. No private API, reviews, or evasion."""
import json
import math
import re
import time
from html.parser import HTMLParser
from urllib.parse import urlsplit

import requests

from services.professor_rating_identity import BASE_URL, professor_id, profile_url, search_url


class SourceUnavailable(Exception):
    """The public source cannot establish a complete, verified summary."""


class SourceRefused(SourceUnavailable):
    """Stop the run on an actual HTTP refusal, rate limit, or challenge."""


class _Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.scripts = []
        self.current = []

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            self.active, self.current = True, []

    def handle_data(self, data):
        if self.active:
            self.current.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.active:
            self.scripts.append("".join(self.current))
            self.active = False


def _documents(markup):
    parser = _Scripts()
    parser.feed(markup)
    decoder = json.JSONDecoder()
    for script in parser.scripts:
        script = script.strip()
        if script.startswith(("{", "[")):
            try:
                yield decoder.raw_decode(script)[0]
            except ValueError:
                continue
        else:
            for match in re.finditer(r"(?:window\.)?__(?:RELAY_STORE|NEXT_DATA|APOLLO_STATE)__\s*=\s*", script):
                try:
                    yield decoder.raw_decode(script[match.end():])[0]
                except ValueError:
                    continue


def _walk(value):
    pending = [(value, 0)]
    visited = 0
    while pending:
        current, depth = pending.pop()
        visited += 1
        if visited > 100000 or depth > 100:
            raise SourceUnavailable("public JSON exceeded traversal bounds")
        if isinstance(current, dict):
            yield current
            pending.extend((child, depth + 1) for child in current.values())
        elif isinstance(current, list):
            pending.extend((child, depth + 1) for child in current)


def parse_summary_page(markup, *, search=False):
    """Allowlist summary fields; complete connections are required for search."""
    if len(markup) > 5_000_000:
        raise SourceUnavailable("public response exceeded 5 MB bound")
    if re.search(r"<title[^>]*>\s*(?:Just a moment|Access denied|Attention Required)|cf-chl-|captcha-container", markup, re.I):
        raise SourceRefused("public page presented a challenge")
    try:
        records = [record for document in _documents(markup) for record in _walk(document)]
    except (RecursionError, ValueError) as error:
        raise SourceUnavailable("public HTML JSON could not be decoded") from error
    references = {}
    for record in records:
        references.update({key: value for key, value in record.items() if isinstance(value, dict)})

    def dereference(value):
        return references.get(value["__ref"], {}) if isinstance(value, dict) and isinstance(value.get("__ref"), str) else value

    if search:
        connections = [record for record in records if record.get("__typename") == "TeacherConnection"]
        if not connections:
            raise SourceUnavailable("public search has no recognizable complete teacher connection")
        search_records = []
        for connection in connections:
            page_info = dereference(connection.get("pageInfo"))
            edges = connection.get("edges")
            if (not isinstance(page_info, dict) or page_info.get("hasNextPage") is not False
                    or page_info.get("hasPreviousPage", False) is not False or not isinstance(edges, list)):
                raise SourceUnavailable("search is paginated or incomplete; exact identity cannot be certified")
            for edge in edges:
                edge = dereference(edge)
                node = dereference(edge.get("node")) if isinstance(edge, dict) else None
                if not isinstance(node, dict) or node.get("__typename") != "Teacher":
                    raise SourceUnavailable("search contains an unresolved teacher")
                search_records.append(node)
        records = search_records
    teachers = {}
    for record in records:
        if record.get("__typename") != "Teacher":
            continue
        identifier = professor_id(record.get("legacyId"))
        school = dereference(record.get("school"))
        school_id = str(school.get("legacyId") or "") if isinstance(school, dict) else ""
        name = " ".join(str(record.get(key) or "").strip() for key in ("firstName", "lastName")).strip()
        if not identifier or not school_id or not name:
            raise SourceUnavailable("teacher identity is incomplete")
        summary = {"professor_id": identifier, "school_id": school_id, "name": name,
                   "overall_rating": record.get("avgRating"), "difficulty": record.get("avgDifficulty"),
                   "rating_count": record.get("numRatings")}
        if identifier in teachers and teachers[identifier] != summary:
            raise SourceUnavailable("public page contains conflicting teacher identities")
        teachers[identifier] = summary
    if not teachers and not search:
        raise SourceUnavailable("public HTML has no supported complete summary data")
    return list(teachers.values())


class PublicPages:
    def __init__(self, delay=1.5, session=None, max_requests=2000):
        if not math.isfinite(delay) or delay < 1:
            raise ValueError("Request delay must be a finite number of at least 1 second")
        if type(max_requests) is not int or not 1 <= max_requests <= 10000:
            raise ValueError("Request limit must be between 1 and 10000")
        self.delay = delay
        self.max_requests = max_requests
        self.request_count = 0
        self.session = session or requests.Session()
        self.last_request = 0
        self.stopped = False
        self.cache = {}

    def _read(self, url):
        if self.stopped:
            raise SourceRefused("refresh halted after source refusal")
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc != "www.ratemyprofessors.com":
            raise ValueError("Only canonical public RMP URLs are accepted")
        for attempt in range(2):
            if self.request_count >= self.max_requests:
                raise SourceUnavailable("public request limit reached")
            time.sleep(max(0, self.delay - (time.monotonic() - self.last_request)))
            self.last_request = time.monotonic()
            self.request_count += 1
            try:
                with self.session.get(url, timeout=(5, 15), allow_redirects=False, stream=True,
                                      headers={"User-Agent": "NestAPStudy-RatingSummary/1.0", "Accept": "text/html"}) as response:
                    if response.status_code in {401, 403, 429} or 300 <= response.status_code < 400:
                        self.stopped = True
                        raise SourceRefused(f"public source refused request (HTTP {response.status_code})")
                    response.raise_for_status()
                    chunks, size = [], 0
                    for chunk in response.iter_content(65536):
                        size += len(chunk)
                        if size > 5_000_000:
                            raise SourceUnavailable("public response exceeded 5 MB bound")
                        chunks.append(chunk)
                    text = b"".join(chunks).decode("utf-8", errors="replace")
                    return text
            except requests.RequestException as error:
                if attempt == 1:
                    raise SourceUnavailable(f"public request failed ({type(error).__name__})") from error
        raise SourceUnavailable("public request failed")

    def _summaries(self, url, search=False):
        try:
            if url not in self.cache:
                self.cache[url] = parse_summary_page(self._read(url), search=search)
            return self.cache[url]
        except SourceRefused:
            self.stopped = True
            raise

    def search(self, school_id, name):
        return self._summaries(search_url(name, school_id), search=True)

    def profile(self, identifier):
        url = profile_url(identifier)
        if not url:
            raise ValueError("Invalid professor ID")
        matches = [item for item in self._summaries(url) if item["professor_id"] == str(identifier)]
        if len(matches) != 1:
            raise SourceUnavailable("profile identity is missing or ambiguous")
        return matches[0]


class FixturePages:
    """Explicit offline summary import; never implicitly substitutes demo data."""
    def __init__(self, data):
        if not isinstance(data, dict) or data.get("schema_version") != 1 or not isinstance(data.get("profiles"), list):
            raise ValueError("Fixture requires schema_version 1 and profiles list")
        if any(not isinstance(item, dict) or not professor_id(item.get("professor_id")) for item in data["profiles"]):
            raise ValueError("Offline profiles require objects with valid professor IDs")
        ids = [str(item["professor_id"]) for item in data["profiles"]]
        if len(ids) != len(set(ids)):
            # Identical duplicate records are harmless; contradictory records are not.
            for identifier in set(ids):
                records = [item for item in data["profiles"] if str(item["professor_id"]) == identifier]
                if any(item != records[0] for item in records):
                    raise ValueError("Offline profiles contain conflicting duplicate IDs")
        self.data = data

    def search(self, school_id, name):
        if self.data.get("unavailable"):
            raise SourceUnavailable("offline import marks source unavailable")
        return [dict(item) for item in self.data["profiles"] if str(item.get("school_id")) == school_id]

    def profile(self, identifier):
        for item in self.data["profiles"]:
            if str(item.get("professor_id")) == str(identifier):
                if item.get("unavailable"):
                    raise SourceUnavailable("offline import marks profile unavailable")
                return dict(item)
        raise SourceUnavailable("profile missing from offline import")
