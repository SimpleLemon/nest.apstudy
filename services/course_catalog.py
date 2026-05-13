"""
Official Emory catalog metadata lookup for course detail views.

The Atlas FOSE search payload is the source of truth for live section status,
but it does not reliably expose catalog descriptions, credits, or GER labels.
This module fetches a single likely Emory College catalog department page on
demand and caches parsed course cards in-process.
"""

import html
import logging
import re
from datetime import datetime, timedelta
from threading import Lock

import requests

logger = logging.getLogger(__name__)

CATALOG_BASE_URL = "https://catalog.college.emory.edu/academics/departments/"
CATALOG_SUBJECT_PATHS = {
    "AAAS": "african-american-studies.html",
    "AMST": "american-studies.html",
    "ANT": "anthropology.html",
    "ARAB": "middle-eastern-and-south-asian-studies.html",
    "ARTHIST": "art-history.html",
    "ARTS": "art.html",
    "BIOL": "biology.html",
    "CHEM": "chemistry.html",
    "CHIN": "chinese.html",
    "CL": "classics.html",
    "CMPL": "comparative-literature.html",
    "CPLT": "comparative-literature.html",
    "CS": "computer-science.html",
    "DANC": "dance.html",
    "ECON": "economics.html",
    "ENG": "english.html",
    "ENVS": "environmental-sciences.html",
    "FILM": "film-and-media.html",
    "FREN": "french.html",
    "GERM": "german-studies.html",
    "HIST": "history.html",
    "ITAL": "italian-studies.html",
    "JPN": "japanese.html",
    "LING": "linguistics.html",
    "MATH": "mathematics.html",
    "MUS": "music.html",
    "NBB": "neuroscience-and-behavioral-biology.html",
    "PHIL": "philosophy.html",
    "PHYS": "physics.html",
    "POLS": "political-science.html",
    "PSYC": "psychology.html",
    "REL": "religion.html",
    "RLGS": "religion.html",
    "RUSS": "russian.html",
    "SOC": "sociology.html",
    "SPAN": "spanish.html",
    "THEA": "theater-studies.html",
    "WGS": "womens-gender-and-sexuality-studies.html",
    "WRIT": "writing-program.html",
}
CATALOG_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
}

_cache = {}
_cache_lock = Lock()
_CACHE_TTL = timedelta(hours=12)


def _strip_tags(value):
    text = re.sub(r"<br\s*/?>", " ", str(value or ""), flags=re.I)
    text = re.sub(r"</p>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def _parse_course_cards(markup):
    courses = {}
    card_pattern = re.compile(
        r'<div class="card"><div class="card-header"[\s\S]*?'
        r"<button[^>]*>([\s\S]*?)</button>[\s\S]*?"
        r'<div class="card-body">([\s\S]*?)</div></div></div>',
        re.I,
    )
    field_pattern = re.compile(r"<dt[^>]*>([\s\S]*?)</dt>\s*<dd[^>]*>([\s\S]*?)</dd>", re.I)

    for match in card_pattern.finditer(markup or ""):
        heading = _strip_tags(match.group(1))
        heading_match = re.match(r"^([A-Z_]+)\s+([A-Z0-9]+[A-Z]?):\s*(.+)$", heading)
        if not heading_match:
            continue
        subject, catalog, title = heading_match.groups()
        body = match.group(2)
        description_match = re.search(r'<p class="card-text">([\s\S]*?)</p>', body, re.I)
        fields = {
            _strip_tags(field.group(1)).lower(): _strip_tags(field.group(2))
            for field in field_pattern.finditer(body)
        }
        requisites = fields.get("requisites")
        if requisites == "None":
            requisites = None
        cross_listed = fields.get("cross-listed")
        if cross_listed == "None":
            cross_listed = None
        courses[(subject.upper(), catalog.upper())] = {
            "course_title": title,
            "credit_hours": fields.get("credit hours"),
            "requirement_designation": fields.get("ger") or fields.get("requirements"),
            "course_description": _strip_tags(description_match.group(1)) if description_match else None,
            "course_notes": fields.get("course notes") or fields.get("notes") or requisites,
            "requisites": requisites,
            "cross_listed": cross_listed,
        }
    return courses


def _department_courses(subject):
    subject = str(subject or "").upper()
    path = CATALOG_SUBJECT_PATHS.get(subject)
    if not path:
        return {}

    now = datetime.utcnow()
    with _cache_lock:
        cached = _cache.get(path)
        if cached and now - cached["ts"] < _CACHE_TTL:
            return cached["courses"]

    try:
        response = requests.get(
            f"{CATALOG_BASE_URL}{path}",
            headers=CATALOG_HEADERS,
            timeout=8,
        )
        response.raise_for_status()
        courses = _parse_course_cards(response.text)
    except requests.RequestException:
        logger.exception("Failed to fetch Emory catalog page for %s", subject)
        courses = {}

    with _cache_lock:
        _cache[path] = {"ts": now, "courses": courses}
    return courses


def get_course_catalog_metadata(subject, catalog):
    """Return official catalog metadata for one course, or an empty dict."""
    subject = str(subject or "").upper()
    catalog = str(catalog or "").upper()
    if not subject or not catalog:
        return {}
    return _department_courses(subject).get((subject, catalog), {})
