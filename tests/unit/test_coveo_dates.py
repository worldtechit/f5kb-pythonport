"""Tests for coveo/dates.py."""

from f5kb.coveo.dates import date_aq, format_date, mod_ms_of, to_coveo_date


def test_to_coveo_date():
    import datetime
    # Use a known UTC datetime
    dt = datetime.datetime(2024, 1, 15, 12, 30, 45, tzinfo=datetime.timezone.utc)
    ms = int(dt.timestamp() * 1000)
    result = to_coveo_date(ms)
    assert result == "2024/01/15@12:30:45"


def test_to_coveo_date_zero_padded():
    # 2024-02-05 01:02:03 UTC
    import datetime
    dt = datetime.datetime(2024, 2, 5, 1, 2, 3, tzinfo=datetime.timezone.utc)
    ms = int(dt.timestamp() * 1000)
    result = to_coveo_date(ms)
    assert result == "2024/02/05@01:02:03"


def test_date_aq_both_bounds():
    start = 1705319445000
    end = 1705319445000 + 86400000  # +1 day
    aq = date_aq(start, end)
    assert "@date>=" in aq
    assert "@date<" in aq
    assert aq.startswith("@date>=")


def test_date_aq_start_only():
    aq = date_aq(start_ms=1705319445000)
    assert aq.startswith("@date>=")
    assert "@date<" not in aq


def test_date_aq_end_only():
    aq = date_aq(end_ms=1705319445000)
    assert aq.startswith("@date<")
    assert "@date>=" not in aq


def test_date_aq_none():
    assert date_aq() == ""


def test_mod_ms_of_prefers_f5_updated():
    raw = {
        "f5_updated_published_date": 111,
        "sflastmodifieddate": 222,
        "date": 333,
    }
    assert mod_ms_of(raw) == 111


def test_mod_ms_of_fallback_sflast():
    raw = {"sflastmodifieddate": 222, "date": 333}
    assert mod_ms_of(raw) == 222


def test_mod_ms_of_fallback_date():
    raw = {"date": 333}
    assert mod_ms_of(raw) == 333


def test_mod_ms_of_empty():
    assert mod_ms_of(None) is None
    assert mod_ms_of({}) is None


def test_format_date():
    # 2024-01-15 UTC
    ms = 1705276800000
    result = format_date(ms)
    assert "Jan" in result
    assert "2024" in result


def test_format_date_none():
    assert format_date(None) == ""
