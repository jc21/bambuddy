"""Logging filters for the Bambuddy log pipeline.

Currently houses a single filter that keeps only state-changing HTTP methods
in the file-side uvicorn access log. See ``WriteRequestsOnlyFilter`` for the
why; this lives in its own module so the test suite can import it without
pulling in ``backend.app.main``'s entire startup graph.
"""

from __future__ import annotations

import logging


class WriteRequestsOnlyFilter(logging.Filter):
    """Keep uvicorn access log records for state-changing HTTP methods only.

    Uvicorn's access logger emits one record per HTTP request, formatted as

        ``<client_addr> - "<METHOD> <path> HTTP/<ver>" <status>``

    On a typical Bambuddy install the bulk of that traffic is GETs — the
    frontend status-polling loop, the camera stream, snapshots, websocket
    upgrades. None of those can change server state on their own, so for
    incident triage ("who hit ``/print/stop`` at 09:23?") they're noise that
    just rotates the log file faster.

    This filter accepts only POST / PUT / PATCH / DELETE — the verbs that
    actually mutate state — and drops everything else. Match anchors on the
    surrounding ``" `` and trailing space so an unrelated literal substring
    in a URL (e.g. ``GET /api/posts/POST``) cannot false-match.

    Attach to ``logging.getLogger("uvicorn.access")`` (and only there — the
    pattern is uvicorn's specific format string and would silently drop
    everything if applied to a generic logger).
    """

    _WRITE_VERB_TOKENS: tuple[str, ...] = (
        ' "POST ',
        ' "PUT ',
        ' "PATCH ',
        ' "DELETE ',
    )

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003 — stdlib API name
        message = record.getMessage()
        return any(token in message for token in self._WRITE_VERB_TOKENS)
