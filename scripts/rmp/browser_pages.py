"""Verified public summaries exported from complete RMP browser directories."""
import base64
from datetime import datetime
from urllib.parse import urlsplit, parse_qs

from scripts.rmp.public_pages import FixturePages
from services.professor_rating_identity import SCHOOLS, profile_url


def complete_directory(directory, rows):
    declared = directory.get("declared_count")
    if type(declared) is not int or declared < 0 or len(rows) > declared:
        return False
    if declared and not rows:
        return False
    if len(rows) == declared:
        return True
    # RMP can repeat profile IDs in its result positions. Require every position
    # and a native terminal page before certifying a smaller unique directory.
    pages = directory.get("pages")
    if not isinstance(pages, list) or not pages:
        return False
    observation = directory.get("rendered_profiles")
    if not isinstance(observation, dict):
        return False
    if (observation.get("source_url") != directory.get("url")
            or observation.get("verification") != "exact_profile_id_set"
            or type(observation.get("unique_count")) is not int
            or observation["unique_count"] != len(rows)):
        return False
    try:
        stamp = datetime.fromisoformat(observation["fetched_at"].replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            return False
    except (KeyError, TypeError, ValueError, AttributeError):
        return False
    positions = set()
    terminal = False
    captured_ids = set()
    pages_with_ids = 0
    for page in pages:
        if not isinstance(page, dict):
            return False
        first, last = page.get("first_position"), page.get("last_position")
        if (type(first) is not int or type(last) is not int or first < 0
                or last < first or last >= declared or page.get("rows") != last - first + 1):
            return False
        if page.get("kind") == "initial_public_cards":
            if first != 0 or page.get("source_url") != directory["url"]:
                return False
        else:
            cursor = base64.b64encode(f"arrayconnection:{last}".encode()).decode()
            if (page.get("source_url") != "https://www.ratemyprofessors.com/graphql"
                    or page.get("status") != 200 or page.get("result_count") != declared
                    or page.get("end_cursor") != cursor
                    or type(page.get("has_next_page")) is not bool):
                return False
            terminal |= page["has_next_page"] is False and last == declared - 1
        positions.update(range(first, last + 1))
        if "profile_ids" in page:
            ids = page["profile_ids"]
            if (not isinstance(ids, list) or len(ids) != page["rows"]
                    or any(not isinstance(identifier, str) or not identifier.isdigit() for identifier in ids)):
                return False
            captured_ids.update(ids)
            pages_with_ids += 1
    if pages_with_ids and (pages_with_ids != len(pages)
                           or captured_ids != {row.get("professor_id") for row in rows if isinstance(row, dict)}):
        return False
    return terminal and len(positions) == declared


class BrowserPages(FixturePages):
    """Keep genuine browser exports distinct from fictional offline fixtures."""

    def __init__(self, document):
        if (not isinstance(document, dict) or document.get("source") != "public-rmp-brave"
                or not isinstance(document.get("directories"), list)):
            raise ValueError("Browser export requires public RMP directory provenance")
        directories = document["directories"]
        schools = set()
        profiles = []
        directory_reports = []
        for directory in directories:
            if not isinstance(directory, dict):
                raise ValueError("Invalid RMP browser directory")
            school = str(directory.get("school_id"))
            url = urlsplit(directory.get("url", ""))
            rows = directory.get("profiles")
            if (school not in SCHOOLS.values() or school in schools
                    or url.scheme != "https" or url.netloc != "www.ratemyprofessors.com"
                    or url.path != f"/search/professors/{school}"
                    or parse_qs(url.query).get("q") != ["*"]
                    or directory.get("complete") is not True
                    or not isinstance(rows, list) or not complete_directory(directory, rows)):
                raise ValueError("RMP browser directory is incomplete or has invalid school provenance")
            schools.add(school)
            identifiers = set()
            for row in rows:
                if (not isinstance(row, dict) or str(row.get("school_id")) != school
                        or row.get("profile_url") != profile_url(row.get("professor_id"))
                        or row.get("professor_id") in identifiers
                        or not isinstance(row.get("name"), str) or not row["name"].strip()):
                    raise ValueError("RMP browser profile identity did not verify")
                identifiers.add(row["professor_id"])
                try:
                    stamp = datetime.fromisoformat(row["fetched_at"].replace("Z", "+00:00"))
                    if stamp.tzinfo is None:
                        raise ValueError("Missing timezone")
                except (KeyError, TypeError, ValueError, AttributeError) as error:
                    raise ValueError("RMP browser profile requires its original retrieval timestamp") from error
                profiles.append(row)
            directory_reports.append({"school_id": school, "declared_positions": directory["declared_count"],
                                      "unique_profiles": len(rows), "duplicate_positions": directory["declared_count"] - len(rows)})
        if schools != set(SCHOOLS.values()):
            raise ValueError("RMP browser export must include complete Emory and Oxford directories")
        super().__init__({"schema_version": document.get("schema_version"), "profiles": profiles})
        self.directory_reports = directory_reports
