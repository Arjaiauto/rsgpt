"""Supabase client with network retries, shared by the pipeline scripts (through
05_captions.supabase_client and db_call) and review_app.py.

call(what, fn) runs fn (a request built on a client from client()) up to ATTEMPTS
times, waiting BACKOFF_SECONDS x 2^(attempt-1) between tries, on network errors
(httpx.TransportError). When the server drops the connection (httpx.RemoteProtocolError,
"Server disconnected"), the client's HTTP/2 connection is not reused: the client is
created again before the retry. A request built inside fn on that client then goes
out on the new connection.
"""

import logging
import os
import threading
import time
import weakref

import httpx
from supabase import create_client

ATTEMPTS = 5
BACKOFF_SECONDS = 5  # 5, 10, 20, 40 s between the 5 attempts

log = logging.getLogger("db")
_clients: "weakref.WeakSet[Client]" = weakref.WeakSet()


class Client:
    """A Supabase client that can be created again in place; other attributes go to the current one."""

    def __init__(self, url: str, key: str):
        self._url, self._key = url, key
        self._thread = threading.get_ident()
        self._client = create_client(url, key)
        _clients.add(self)

    def reconnect(self) -> None:
        self._client = create_client(self._url, self._key)

    def __getattr__(self, name):
        return getattr(self._client, name)


def client(url: str | None = None, key: str | None = None) -> Client:
    url = url or os.environ.get("SUPABASE_URL")
    key = key or os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env")
    return Client(url, key)


def call(what: str, fn, db: Client | None = None):
    """fn() with retries. On a dropped connection, db is created again, or, if db is not given,
    every client created in this thread (a client is used by one thread only)."""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            return fn()
        except httpx.TransportError as exc:
            if attempt == ATTEMPTS:
                raise
            wait = BACKOFF_SECONDS * 2 ** (attempt - 1)
            reconnect = isinstance(exc, httpx.RemoteProtocolError)
            log.warning("%s: network error (%s: %s), %sretrying in %ss (attempt %s of %s)", what,
                        type(exc).__name__, exc, "new client, " if reconnect else "", wait, attempt, ATTEMPTS)
            if reconnect:
                for c in [db] if db is not None else [c for c in list(_clients)
                                                      if c._thread == threading.get_ident()]:
                    c.reconnect()
            time.sleep(wait)
    raise AssertionError("unreachable")
