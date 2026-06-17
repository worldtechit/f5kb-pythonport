"""Regression tests: hash stability for known fixture articles.

Hardcoded hash values computed from the current fixture data.
A change in hashing logic, canonical serialization, or fixture content
will cause these tests to fail — that is the intended behavior.
"""

import json
from pathlib import Path

from f5kb.track.hashing import sha256_obj, to_record

FIXTURES = Path(__file__).parent.parent / "fixtures" / "dump_mini"


def _load(rel: str) -> dict:
    return json.loads((FIXTURES / rel).read_text())


# ---- K14448 (Knowledge) ----

def test_k14448_metadata_hash_stable():
    art = _load("Knowledge/K14448.json")
    h = sha256_obj(art["metadata"])
    assert h == "6b6ca2ae6aa02d6c923f4cb1c8b962a6be5956ff570b73f2992a775f6db45050"


def test_k14448_content_hash_stable():
    art = _load("Knowledge/K14448.json")
    h = sha256_obj(art["content"])
    assert h == "96ee43216f3e8eacf5727add1930691100443051fe9e31311df58224d5b73bd4"


def test_k14448_to_record_hashes_stable():
    art = _load("Knowledge/K14448.json")
    rec = to_record(art)
    assert rec.metadata_hash == "6b6ca2ae6aa02d6c923f4cb1c8b962a6be5956ff570b73f2992a775f6db45050"
    assert rec.content_hash == "96ee43216f3e8eacf5727add1930691100443051fe9e31311df58224d5b73bd4"
    assert rec.has_body == 1
    assert rec.id == "K14448"
    assert rec.document_type == "Knowledge"


# ---- Bug Tracker article ----

def test_bug_tracker_metadata_hash_stable():
    rel = "Bug_Tracker/ac8677dca4ef6ee1ebbad29b7eb407dee0d138d3260d78886cb678c18a64.json"
    art = _load(rel)
    h = sha256_obj(art["metadata"])
    assert h == "368bd410355b07ce2b62532bc14c7363b6e5b6facd822212fb0bfc190823e7dc"


def test_bug_tracker_content_hash_stable():
    rel = "Bug_Tracker/ac8677dca4ef6ee1ebbad29b7eb407dee0d138d3260d78886cb678c18a64.json"
    art = _load(rel)
    h = sha256_obj(art["content"])
    assert h == "45806224785811cf3213abf81a5c04627630410ab6e0e53c84f4e6a68829fa54"


def test_bug_tracker_to_record_has_body():
    rel = "Bug_Tracker/ac8677dca4ef6ee1ebbad29b7eb407dee0d138d3260d78886cb678c18a64.json"
    art = _load(rel)
    rec = to_record(art)
    assert rec.has_body == 1
    assert rec.body_error is None


# ---- Hash determinism across fixture ----

def test_all_fixtures_produce_64char_hashes():
    bad = []
    for f in FIXTURES.rglob("*.json"):
        if f.name.startswith("_"):
            continue
        art = json.loads(f.read_text())
        rec = to_record(art)
        if len(rec.metadata_hash) != 64 or len(rec.content_hash) != 64:
            bad.append(f.name)
    assert not bad, f"Articles with invalid hash length: {bad}"


def test_hash_order_independence():
    """Key order in metadata must not affect hash (canonical sort)."""
    art = _load("Knowledge/K14448.json")
    meta = art["metadata"]
    # Reverse key order
    meta_reversed = dict(reversed(list(meta.items())))
    assert sha256_obj(meta) == sha256_obj(meta_reversed)
