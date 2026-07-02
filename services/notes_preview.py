import json
import re

PREVIEW_MAX_LENGTH = 280
BLANK_PREVIEW = "Blank note"


def _block_text(block):
    if not block or not isinstance(block, dict):
        return ""

    block_type = block.get("type")
    props = block.get("props") if isinstance(block.get("props"), dict) else {}

    if block_type == "bookmark":
        return " ".join(
            part for part in (props.get("title"), props.get("description"), props.get("url")) if part
        )
    if block_type in {"image", "video"}:
        return " ".join(
            part for part in (props.get("caption"), props.get("name"), props.get("url")) if part
        )
    if block_type in {"divider", "pageBreak", "horizontalRule"}:
        return ""

    own = ""
    content = block.get("content")
    if isinstance(content, list):
        own = " ".join(_inline_text(item) for item in content).strip()

    children = block.get("children")
    child_text = ""
    if isinstance(children, list):
        child_text = " ".join(_block_text(child) for child in children).strip()

    return f"{own} {child_text}".strip()


def _inline_text(item):
    if not item or not isinstance(item, dict):
        return ""
    if item.get("type") == "link" and isinstance(item.get("content"), list):
        return "".join(_inline_text(child) for child in item["content"])
    if item.get("type") == "inlineImage":
        props = item.get("props") if isinstance(item.get("props"), dict) else {}
        return str(props.get("alt") or props.get("url") or "Image")
    text = item.get("text")
    return text if isinstance(text, str) else ""


def preview_text_from_content(content):
    if not isinstance(content, str) or not content.strip():
        return BLANK_PREVIEW

    try:
        blocks = json.loads(content)
    except (TypeError, ValueError, json.JSONDecodeError):
        return BLANK_PREVIEW

    if not isinstance(blocks, list):
        return BLANK_PREVIEW

    text = " ".join(_block_text(block) for block in blocks)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return BLANK_PREVIEW

    if len(text) <= PREVIEW_MAX_LENGTH:
        return text
    return f"{text[: PREVIEW_MAX_LENGTH - 1].rstrip()}…"
