"""Tests for lib/logger.py."""

import json

from f5kb.lib.logger import NULL_LOGGER, make_logger


def capture_logger(level="info", json_mode=False, scope=""):
    lines = []
    logger = make_logger(level=level, json_mode=json_mode, scope=scope, write=lines.append)
    return logger, lines


def test_info_logged():
    log, lines = capture_logger()
    log.info("hello")
    assert len(lines) == 1
    assert "hello" in lines[0]


def test_level_filtering():
    log, lines = capture_logger(level="warn")
    log.info("should be hidden")
    log.warn("should appear")
    assert len(lines) == 1
    assert "should appear" in lines[0]


def test_debug_hidden_at_info():
    log, lines = capture_logger(level="info")
    log.debug("hidden")
    assert lines == []


def test_trace_hidden_at_info():
    log, lines = capture_logger(level="info")
    log.trace("hidden")
    assert lines == []


def test_trace_shown_at_trace():
    log, lines = capture_logger(level="trace")
    log.trace("visible")
    assert len(lines) == 1
    assert "visible" in lines[0]


def test_json_mode_valid_json():
    log, lines = capture_logger(json_mode=True)
    log.info("test message", count=5)
    assert len(lines) == 1
    obj = json.loads(lines[0])
    assert obj["msg"] == "test message"
    assert obj["level"] == "info"
    assert obj["count"] == 5
    assert "ts" in obj


def test_json_mode_scope():
    log, lines = capture_logger(json_mode=True, scope="dump")
    log.info("msg")
    obj = json.loads(lines[0])
    assert obj["scope"] == "dump"


def test_no_scope_in_json_when_empty():
    log, lines = capture_logger(json_mode=True, scope="")
    log.info("msg")
    obj = json.loads(lines[0])
    assert "scope" not in obj


def test_text_mode_level_prefix():
    log, lines = capture_logger(level="info")
    log.error("oops")
    assert lines[0].startswith("ERROR")


def test_text_mode_scope_prefix():
    log, lines = capture_logger(scope="mymod")
    log.info("msg")
    assert "[mymod]" in lines[0]


def test_child_inherits_level():
    log, lines = capture_logger(level="debug")
    child = log.child("sub")
    child.debug("visible")
    assert len(lines) == 1


def test_child_scope_combined():
    log, lines = capture_logger(scope="parent")
    child = log.child("child")
    child.info("msg")
    assert "[parent:child]" in lines[0]


def test_child_no_parent_scope():
    log, lines = capture_logger(scope="")
    child = log.child("only")
    child.info("msg")
    assert "[only]" in lines[0]


def test_timer_logs_elapsed():
    log, lines = capture_logger(level="debug")
    stop = log.timer("my_op")
    stop()
    assert len(lines) == 1
    assert "my_op" in lines[0]
    assert "ms" in lines[0]


def test_null_logger_silent():
    NULL_LOGGER.error("this is dropped")
    NULL_LOGGER.info("also dropped")
    # no assertion — just must not raise


def test_level_property():
    log = make_logger(level="debug")
    assert log.level == "debug"
