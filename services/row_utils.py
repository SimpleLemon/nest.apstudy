"""Shared helpers for Appwrite-shaped row mappings."""


def row_id(row):
    return (row or {}).get("$id") or (row or {}).get("id")


def row_to_dict(row):
    """Flatten SDK row data while retaining row metadata and dict identity."""
    if isinstance(row, dict):
        return row
    if hasattr(row, "to_dict"):
        value = row.to_dict()
    elif hasattr(row, "model_dump"):
        value = row.model_dump(by_alias=True, mode="json")
    else:
        return row

    data = value.pop("data", None)
    if isinstance(data, dict):
        value.update(data)
    return value
