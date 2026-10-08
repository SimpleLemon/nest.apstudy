#!/usr/bin/env python3
"""Three-process synthetic local upload/download/ZIP RSS measurement, without network."""

from __future__ import annotations

import argparse
import base64
import gc
import io
import json
import multiprocessing
import os
import resource
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from flask import Flask

from services import database, storage_objects


def _peak_rss_bytes():
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value if sys.platform == "darwin" else value * 1024


def _app(keyring):
    app = Flask("synthetic_storage_memory_profile")
    app.config.update(NEST_UPLOAD_KEYRING_PATH=str(keyring), NEST_STORAGE_MUTATIONS_PAUSED=False)
    return app


def _synthetic_pdf(byte_length):
    """A generated one-page PDF with a bounded, unused padding stream."""
    output = io.BytesIO()
    output.write(b"%PDF-1.4\n")
    offsets = [0]
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
               b"<< /Length 4 >>\nstream\nq Q\nendstream"]
    for index, content in enumerate(objects, 1):
        offsets.append(output.tell())
        output.write(f"{index} 0 obj\n".encode() + content + b"\nendobj\n")
    padding = max(0, byte_length - output.tell() - 300)
    offsets.append(output.tell())
    output.write(f"5 0 obj\n<< /Length {padding} >>\nstream\n".encode())
    chunk = b"x" * 65536
    remaining = padding
    while remaining:
        written = min(remaining, len(chunk))
        output.write(chunk[:written])
        remaining -= written
    output.write(b"\nendstream\nendobj\n")
    xref = output.tell()
    output.write(b"xref\n0 6\n0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.write(f"{offset:010d} 00000 n \n".encode())
    output.write(f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return output.getvalue()


def _worker(path, keyring, ready, start, output, zip_members, object_bytes):
    baseline = _peak_rss_bytes()
    ready.put(True)
    start.wait(30)
    try:
        with _app(keyring).app_context():
            data = storage_objects.read_object("shared_files", "synthetic", path=path)
            read_peak = _peak_rss_bytes()
            del data
            gc.collect()
            original = os.urandom(object_bytes)
            with patch.object(storage_objects, "scan_upload"):
                prepared = storage_objects.prepare_object("shared_files", f"upload-{os.getpid()}", original,
                                                           filename="synthetic.bin", mime_type="application/octet-stream")
            upload_prepared_peak = _peak_rss_bytes()
            with storage_objects.write_transaction(path=path) as conn:
                storage_objects.put_object(conn, prepared)
            upload_peak = _peak_rss_bytes()
            del original, prepared
            gc.collect()
            # Match the feature's one-MiB spill threshold rather than keeping
            # the entire incompressible ZIP in another memory buffer.
            with tempfile.SpooledTemporaryFile(max_size=1024 * 1024, mode="w+b") as buffer:
                with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                    for index in range(zip_members):
                        data = storage_objects.read_object("shared_files", "synthetic", path=path)
                        archive.writestr(f"synthetic-{index}.bin", data)
                        del data
                zip_size = buffer.tell()
            zip_peak = _peak_rss_bytes()
            from services.chat_attachment_validation import _pdf_thumbnail
            pdf = _synthetic_pdf(object_bytes)
            preview = _pdf_thumbnail(pdf)
            if preview is None:
                raise RuntimeError("Generated PDF preview failed")
            preview_bytes = len(preview[0])
        output.put({"baseline_rss": baseline, "read_peak_rss": read_peak,
                    "upload_prepared_peak_rss": upload_prepared_peak, "upload_peak_rss": upload_peak,
                    "zip_peak_rss": zip_peak, "zip_bytes": zip_size,
                    "preview_peak_rss": _peak_rss_bytes(), "preview_bytes": preview_bytes,
                    "pdf_bytes": len(pdf)})
    except Exception as exc:
        output.put({"failed": type(exc).__name__})


def profile(*, object_mib=50, workers=3, zip_members=2):
    if not 1 <= object_mib <= 50 or not 1 <= workers <= 8 or not 1 <= zip_members <= 8:
        raise ValueError("Use 1..50 MiB, 1..8 workers, and 1..8 ZIP members.")
    context = multiprocessing.get_context("spawn")
    with tempfile.TemporaryDirectory(prefix="nest-synthetic-storage-") as temporary:
        directory = Path(temporary)
        keyring, path = directory / "synthetic-keys.json", directory / "synthetic.sqlite3"
        keyring.write_text(json.dumps({"active_key_id": "synthetic", "keys": {
            "synthetic": base64.b64encode(os.urandom(32)).decode("ascii")}}), encoding="utf-8")
        keyring.chmod(0o600)
        database.init_db(path=path)
        with _app(keyring).app_context(), patch.object(storage_objects, "scan_upload"):
            # Only generated local bytes use a mocked scanner. Production scanning is never disabled.
            prepared = storage_objects.prepare_object("shared_files", "synthetic", os.urandom(object_mib * 1024 * 1024),
                                                       filename="synthetic.bin", mime_type="application/octet-stream")
            with storage_objects.write_transaction(path=path) as conn:
                storage_objects.put_object(conn, prepared)
        del prepared
        gc.collect()
        ready, output, start = context.Queue(), context.Queue(), context.Event()
        children = [context.Process(target=_worker, args=(path, keyring, ready, start, output, zip_members, object_mib * 1024 * 1024))
                    for _ in range(workers)]
        for child in children:
            child.start()
        try:
            for _ in children:
                ready.get(timeout=30)
            started = time.monotonic()
            start.set()
            results = [output.get(timeout=120) for _ in children]
            for child in children:
                child.join(timeout=5)
            return {"synthetic": True, "scanner_mocked_for_generated_bytes": True,
                    "workers": workers, "object_bytes": object_mib * 1024 * 1024,
                    "zip_members_per_worker": zip_members, "elapsed_seconds": round(time.monotonic() - started, 2),
                    "processes": results, "summed_peak_rss_bytes": sum(row.get("preview_peak_rss", 0) for row in results),
                    "failed": any(row.get("failed") for row in results)}
        finally:
            for child in children:
                if child.is_alive():
                    child.terminate()
                child.join(timeout=5)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--object-mib", type=int, default=50)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--zip-members", type=int, default=2)
    args = parser.parse_args(argv)
    result = profile(object_mib=args.object_mib, workers=args.workers, zip_members=args.zip_members)
    print(json.dumps(result, sort_keys=True))
    return int(result["failed"])


if __name__ == "__main__":
    raise SystemExit(main())
