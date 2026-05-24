import hashlib
import html
import ipaddress
import re
import socket
from urllib.parse import urljoin, urlparse

import requests


URL_RE = re.compile(r"https?://[^\s<>()\"']+", re.IGNORECASE)
MARKDOWN_LINK_RE = re.compile(r"\[([^\]\n]{1,120})\]\((https?://[^)\s]+)\)")
CODE_RE = re.compile(r"`([^`\n]{1,500})`")
MAX_PREVIEW_BYTES = 256 * 1024
PREVIEW_TIMEOUT = 3
IMAGE_TYPES = {"image/gif", "image/jpeg", "image/png", "image/webp"}


def url_hash(url):
    return hashlib.sha256(str(url or "").strip().encode("utf-8")).hexdigest()


def safe_url(value):
    raw = str(value or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"}:
        return ""
    if not parsed.netloc or not parsed.hostname:
        return ""
    return raw


def extract_links(content, limit=4):
    links = []
    seen = set()
    for match in URL_RE.finditer(str(content or "")):
        value = match.group(0).rstrip(".,;:!?)]}")
        safe = safe_url(value)
        if safe and safe not in seen:
            seen.add(safe)
            links.append(safe)
        if len(links) >= limit:
            break
    return links


def render_markdown(content):
    raw = str(content or "")[:4000]
    code_tokens = []

    def stash_code(match):
        code_tokens.append(f"<code>{html.escape(match.group(1))}</code>")
        return f"@@CODE{len(code_tokens) - 1}@@"

    text = CODE_RE.sub(stash_code, raw)
    text = html.escape(text)
    link_tokens = []

    def markdown_link(match):
        label = html.escape(match.group(1))
        url = safe_url(html.unescape(match.group(2)))
        if not url:
            return label
        escaped_url = html.escape(url, quote=True)
        link_tokens.append(f'<a href="{escaped_url}" target="_blank" rel="noopener noreferrer nofollow">{label}</a>')
        return f"@@LINK{len(link_tokens) - 1}@@"

    text = MARKDOWN_LINK_RE.sub(markdown_link, text)

    def raw_link(match):
        url = html.unescape(match.group(0)).rstrip(".,;:!?)]}")
        safe = safe_url(url)
        if not safe:
            return match.group(0)
        escaped_url = html.escape(safe, quote=True)
        label = html.escape(safe)
        return f'<a href="{escaped_url}" target="_blank" rel="noopener noreferrer nofollow">{label}</a>'

    text = URL_RE.sub(raw_link, text)
    text = re.sub(r"\*\*([^*\n]{1,500})\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"~~([^~\n]{1,500})~~", r"<del>\1</del>", text)
    text = re.sub(r"(?<!\*)\*([^*\n]{1,300})\*(?!\*)", r"<em>\1</em>", text)
    text = text.replace("\n", "<br>")
    for index, rendered in enumerate(link_tokens):
        text = text.replace(f"@@LINK{index}@@", rendered)
    for index, rendered in enumerate(code_tokens):
        text = text.replace(f"@@CODE{index}@@", rendered)
    return text


def _is_public_host(url):
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror:
        return False
    for result in addresses:
        ip = ipaddress.ip_address(result[4][0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return False
    return True


def _metadata(html_text, base_url):
    def meta_value(*names):
        for name in names:
            pattern = re.compile(
                rf'<meta\s+[^>]*(?:property|name)=["\']{re.escape(name)}["\'][^>]*content=["\']([^"\']+)["\'][^>]*>',
                re.IGNORECASE,
            )
            match = pattern.search(html_text)
            if match:
                return html.unescape(match.group(1)).strip()
        return ""

    title = meta_value("og:title", "twitter:title")
    if not title:
        match = re.search(r"<title[^>]*>(.*?)</title>", html_text, re.IGNORECASE | re.DOTALL)
        if match:
            title = html.unescape(re.sub(r"\s+", " ", match.group(1))).strip()

    image_url = meta_value("og:image", "twitter:image")
    if image_url:
        image_url = urljoin(base_url, image_url)
        if not safe_url(image_url):
            image_url = ""

    return {
        "title": title[:255],
        "description": meta_value("og:description", "description", "twitter:description")[:512],
        "image_url": image_url[:2048],
        "site_name": meta_value("og:site_name")[:255],
    }


def fetch_link_preview(url):
    safe = safe_url(url)
    if not safe or not _is_public_host(safe):
        return None

    current_url = safe
    headers = {
        "User-Agent": "Nest.APStudy link preview bot",
        "Accept": "text/html,image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8",
    }

    for _ in range(4):
        response = requests.get(current_url, headers=headers, timeout=PREVIEW_TIMEOUT, allow_redirects=False, stream=True)
        if 300 <= response.status_code < 400 and response.headers.get("Location"):
            current_url = urljoin(current_url, response.headers["Location"])
            if not safe_url(current_url) or not _is_public_host(current_url):
                return None
            continue
        break
    else:
        return None

    content_type = (response.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
    if content_type in IMAGE_TYPES:
        return {
            "url": current_url,
            "title": "",
            "description": "",
            "image_url": current_url,
            "site_name": urlparse(current_url).netloc,
            "content_type": content_type,
        }

    if not content_type.startswith("text/html"):
        return None

    chunks = []
    total = 0
    for chunk in response.iter_content(8192):
        if not chunk:
            continue
        chunks.append(chunk)
        total += len(chunk)
        if total >= MAX_PREVIEW_BYTES:
            break
    html_text = b"".join(chunks).decode(response.encoding or "utf-8", errors="replace")
    metadata = _metadata(html_text, current_url)
    if not metadata.get("title") and not metadata.get("image_url"):
        return None
    return {
        "url": current_url,
        **metadata,
        "content_type": content_type,
    }
