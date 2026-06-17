"""Throttled progress reporter.

Writes to STDERR only (never STDOUT). When stderr is a TTY it rewrites a single
line in place at ~4 Hz; otherwise emits a plain periodic line every ~2s.
"""

from __future__ import annotations

import sys
import time
from typing import Callable

from f5kb.lib.logger import Logger

TTY_INTERVAL = 0.25   # ~4 Hz
PLAIN_INTERVAL = 2.0  # every ~2s when not a TTY


def _fmt_duration(sec: float) -> str:
    if sec < 60:
        return f"{sec:.0f}s"
    m = int(sec // 60)
    s = round(sec % 60)
    if m < 60:
        return f"{m}m{s:02d}s"
    h = m // 60
    return f"{h}h{m % 60:02d}m"


class Progress:
    def __init__(
        self,
        is_tty: bool | None = None,
        write: Callable[[str], None] | None = None,
        logger: Logger | None = None,
    ) -> None:
        self._is_tty = is_tty if is_tty is not None else _safe_is_tty()
        self._write = write or _default_write
        self._logger = logger
        self._label = ""
        self._total: int | None = None
        self._n = 0
        self._start = 0.0
        self._last_emit = 0.0
        self._last_len = 0
        self._active = False

    def start(self, label: str, total: int | None = None) -> None:
        self._label = label
        self._total = total
        self._n = 0
        self._start = time.monotonic()
        self._last_emit = 0.0
        self._last_len = 0
        self._active = True

    def update(self, n: int, extra: str | None = None) -> None:
        if not self._active:
            return
        self._n = n
        now = time.monotonic()
        interval = TTY_INTERVAL if self._is_tty else PLAIN_INTERVAL
        if now - self._last_emit < interval:
            return
        self._last_emit = now
        self._render(self._build_line(extra), final=False)

    def done(self, extra: str | None = None) -> None:
        if not self._active:
            return
        self._active = False
        line = self._build_line(extra)
        self._render(line, final=True)
        if self._logger:
            self._logger.info(line.strip())

    def _build_line(self, extra: str | None) -> str:
        elapsed = time.monotonic() - self._start
        per_sec = self._n / elapsed if elapsed > 0 else 0.0
        count = f"{self._n}/{self._total}" if self._total is not None else str(self._n)
        parts = [f"{self._label}: {count}", f"{per_sec:.1f}/s", _fmt_duration(elapsed)]
        if extra:
            parts.append(extra)
        return "  ".join(parts)

    def _render(self, line: str, final: bool) -> None:
        if self._is_tty:
            pad = max(0, self._last_len - len(line))
            self._write(f"\r{line}{' ' * pad}")
            self._last_len = len(line)
            if final:
                self._write("\n")
        else:
            self._write(line + "\n")


def make_progress(logger: Logger | None = None) -> Progress:
    return Progress(logger=logger)


def _safe_is_tty() -> bool:
    try:
        return sys.stderr.isatty()
    except Exception:
        return False


def _default_write(s: str) -> None:
    try:
        sys.stderr.write(s)
        sys.stderr.flush()
    except Exception:
        pass
