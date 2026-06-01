from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


DEFAULT_AVATAR_URL = (
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'%3E"
    "%3Crect width='96' height='96' rx='24' fill='%23e5e7eb'/%3E"
    "%3Ccircle cx='48' cy='35' r='17' fill='%239ca3af'/%3E"
    "%3Cpath d='M20 82c4-18 17-28 28-28s24 10 28 28' fill='%239ca3af'/%3E"
    "%3C/svg%3E"
)
APSTUDY_LOGO_URL = "https://resources.apstudy.org/images/AP-Resources-Logo.png"


def avatar_url_for_size(url, size=32):
    """Return a provider URL that asks for a smaller avatar when supported."""
    raw_url = str(url or "").strip()
    if not raw_url:
        return DEFAULT_AVATAR_URL

    try:
        normalized_size = int(size)
    except (TypeError, ValueError):
        normalized_size = 32
    normalized_size = max(16, min(normalized_size, 512))

    parsed = urlsplit(raw_url)
    host = parsed.netloc.lower()
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))

    if "githubusercontent.com" in host:
        query["s"] = str(normalized_size)
        return urlunsplit(parsed._replace(query=urlencode(query, doseq=True)))

    if "discordapp.com" in host or "discord.com" in host:
        query["size"] = str(_discord_size(normalized_size))
        return urlunsplit(parsed._replace(query=urlencode(query, doseq=True)))

    if "googleusercontent.com" in host:
        return _google_avatar_url(raw_url, normalized_size)

    if "cloud.appwrite.io" in host and "/storage/buckets/" in parsed.path:
        query["width"] = str(normalized_size)
        query["height"] = str(normalized_size)
        return urlunsplit(parsed._replace(query=urlencode(query, doseq=True)))

    return raw_url


def _discord_size(size):
    allowed_sizes = (16, 32, 64, 128, 256, 512)
    return min(allowed_sizes, key=lambda candidate: abs(candidate - size))


def _google_avatar_url(raw_url, size):
    for marker in ("=s", "?sz="):
        marker_index = raw_url.rfind(marker)
        if marker_index == -1:
            continue

        prefix = raw_url[:marker_index + len(marker)]
        suffix = raw_url[marker_index + len(marker):]
        suffix_index = 0
        while suffix_index < len(suffix) and suffix[suffix_index].isdigit():
            suffix_index += 1
        return f"{prefix}{size}{suffix[suffix_index:]}"

    separator = "&" if "?" in raw_url else "?"
    return f"{raw_url}{separator}sz={size}"
