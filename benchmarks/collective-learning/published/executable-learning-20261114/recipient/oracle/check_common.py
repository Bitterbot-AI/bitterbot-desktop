"""Host-owned bounded parsers. The learner never receives this directory."""
import io
import pathlib
import re
import xml.etree.ElementTree as ET
import zipfile


class InvalidArtifact(ValueError):
    pass


class CheckerRuntimeUnavailable(RuntimeError):
    pass


def bounded_zip(file):
    try:
        archive = zipfile.ZipFile(file if isinstance(file, (str, pathlib.Path)) else io.BytesIO(file))
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) > 512 or len(set(names)) != len(names) or sum(e.file_size for e in entries) > 24 * 1024 * 1024:
            raise InvalidArtifact("zip-limit-or-duplicate")
        for entry in entries:
            parts = pathlib.PurePosixPath(entry.filename)
            if parts.is_absolute() or ".." in parts.parts or "\\" in entry.filename or entry.flag_bits & 1:
                raise InvalidArtifact("unsafe-zip-entry")
        return archive
    except (zipfile.BadZipFile, OSError) as error:
        raise InvalidArtifact("malformed-zip") from error


def xml(content):
    if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
        raise InvalidArtifact("xml-entity-declaration")
    try:
        return ET.fromstring(content)
    except ET.ParseError as error:
        raise InvalidArtifact("malformed-xml") from error


def normalize(text):
    return re.sub(r"\s+", " ", text).strip()


def verdict(issues, details=None):
    return {"status": "pass" if not issues else "task-failure", "issues": sorted(set(issues)), "details": details or {}}

