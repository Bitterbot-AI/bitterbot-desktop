"""Normalize supplied source records without network access or installation."""
from datetime import datetime


def normalize(sources):
    result, seen = [], set()
    for source in sources:
        if source["id"] in seen:
            raise ValueError("Duplicate source identifier")
        seen.add(source["id"])
        if source["status"] != "current":
            continue
        date = datetime.fromisoformat(source["publishedAt"].replace("Z", "+00:00")).date()
        result.append({**source, "date": date.isoformat()})
    return result
