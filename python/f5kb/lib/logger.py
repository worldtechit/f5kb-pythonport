"""Structured, leveled logger. All output goes to STDERR so machine-readable
--json output stays clean on STDOUT.

Levels (most to least severe): error < warn < info < debug < trace.
CLI flags: --quiet=warn, default=info, --verbose=debug, --debug=trace.
--json-logs emits one NDJSON object per line.
"""

from __future__ import annotations

import json
import sys
import time
from typing import Callable

# Custom TRACE level below DEBUG (10)
TRACE = 5

_ORDER = {"error": 0, "warn": 1, "info": 2, "debug": 3, "trace": 4}
_LEVEL_INT = {"error": 40, "warn": 30, "info": 20, "debug": 10, "trace": TRACE}


class Logger:
    def __init__(
        self,
        level: str = "info",
        json_mode: bool = False,
        scope: str = "",
        write: Callable[[str], None] | None = None,
    ) -> None:
        self._level = level
        self._threshold = _ORDER.get(level, 2)
        self._json = json_mode
        self._scope = scope
        self._write = write or (lambda line: sys.stderr.write(line + "\n"))

    @property
    def level(self) -> str:
        return self._level

    def _emit(self, lvl: str, msg: str, **meta: object) -> None:
        if _ORDER.get(lvl, 99) > self._threshold:
            return
        if self._json:
            record: dict = {
                "ts": _iso_now(),
                "level": lvl,
                "msg": msg,
            }
            if self._scope:
                record["scope"] = self._scope
            record.update(meta)
            self._write(json.dumps(record))
        else:
            prefix = f"[{self._scope}] " if self._scope else ""
            meta_str = ("  " + json.dumps(meta)) if meta else ""
            self._write(f"{lvl.upper():<5} {prefix}{msg}{meta_str}")

    def error(self, msg: str, **meta: object) -> None:
        self._emit("error", msg, **meta)

    def warn(self, msg: str, **meta: object) -> None:
        self._emit("warn", msg, **meta)

    def info(self, msg: str, **meta: object) -> None:
        self._emit("info", msg, **meta)

    def debug(self, msg: str, **meta: object) -> None:
        self._emit("debug", msg, **meta)

    def trace(self, msg: str, **meta: object) -> None:
        self._emit("trace", msg, **meta)

    def timer(self, label: str) -> Callable[[], None]:
        start = time.monotonic()

        def stop() -> None:
            ms = round((time.monotonic() - start) * 1000)
            self.debug(f"{label} ({ms}ms)")

        return stop

    def child(self, scope: str) -> "Logger":
        combined = f"{self._scope}:{scope}" if self._scope else scope
        return Logger(
            level=self._level,
            json_mode=self._json,
            scope=combined,
            write=self._write,
        )


def make_logger(
    level: str = "info",
    json_mode: bool = False,
    scope: str = "",
    write: Callable[[str], None] | None = None,
) -> Logger:
    return Logger(level=level, json_mode=json_mode, scope=scope, write=write)


NULL_LOGGER = Logger(level="error", write=lambda _: None)


def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"
