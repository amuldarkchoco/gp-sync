"""A small cache for API answers.

Kept in the app's own memory (bounded, fastest, nothing extra to run). Set REDIS_URL to
use a Redis or Valkey server instead, for example when several copies share one cache.
Every database write bumps a generation number that is part of each key, so cached
answers never outlive the data they came from.
"""

import collections
import os
import sys
import threading
import time

URL = os.environ.get("REDIS_URL", "")
PREFIX = "gps:"
MEMORY_LIMIT = 8 * 1024 * 1024  # bytes kept in memory
RETRY_AFTER = 30  # seconds to wait before trying Redis again after an error

_lock = threading.Lock()
_mem = collections.OrderedDict()  # key -> (expires, bytes)
_mem_bytes = 0
_client = None
_down_until = 0.0
_gen = 0
stats = {"hits": 0, "misses": 0, "errors": 0}


def generation():
    return _gen


def bump():
    """Data changed: answers cached before now are stale."""
    global _gen
    _gen += 1


def _redis():
    """The Redis client, or None while Redis is not configured or not reachable."""
    global _client, _down_until
    if not URL or time.monotonic() < _down_until:
        return None
    if _client is None:
        try:
            import redis

            _client = redis.Redis.from_url(
                URL, socket_timeout=0.5, socket_connect_timeout=0.5, health_check_interval=60
            )
        except Exception as e:  # missing package or a bad URL: use memory
            _fail(e)
            return None
    return _client


def _fail(e):
    global _down_until
    stats["errors"] += 1
    if time.monotonic() >= _down_until:
        print(f"Cache: Redis unavailable ({type(e).__name__}: {e}); using memory", file=sys.stderr, flush=True)
    _down_until = time.monotonic() + RETRY_AFTER


def remote():
    """True when a Redis server holds the cache (worth keeping bigger things like thumbnails)."""
    return _redis() is not None


def get(key):
    r = _redis()
    if r is not None:
        try:
            value = r.get(PREFIX + key)
        except Exception as e:
            _fail(e)
        else:
            stats["hits" if value is not None else "misses"] += 1
            return value
    with _lock:
        hit = _mem.get(key)
        if hit and hit[0] > time.monotonic():
            _mem.move_to_end(key)
            stats["hits"] += 1
            return hit[1]
        stats["misses"] += 1
        return None


def set(key, value, ttl):
    """Store bytes for `ttl` seconds."""
    global _mem_bytes
    r = _redis()
    if r is not None:
        try:
            r.set(PREFIX + key, value, ex=max(1, int(ttl)))
            return
        except Exception as e:
            _fail(e)
    if len(value) > MEMORY_LIMIT // 8:
        return
    with _lock:
        old = _mem.pop(key, None)
        if old:
            _mem_bytes -= len(old[1])
        _mem[key] = (time.monotonic() + ttl, value)
        _mem_bytes += len(value)
        while _mem_bytes > MEMORY_LIMIT and _mem:
            _, (_, dropped) = _mem.popitem(last=False)
            _mem_bytes -= len(dropped)


def remember(key, ttl, make):
    """Cached bytes for `key` in the current data generation, made with make() on a miss."""
    k = f"{key}@{_gen}"
    value = get(k)
    if value is None:
        value = make()
        set(k, value, ttl)
    return value


def clear():
    global _mem_bytes
    with _lock:
        _mem.clear()
        _mem_bytes = 0
    bump()


def info():
    """What the Health page shows about the cache."""
    out = {"backend": "memory", "connected": False, **stats, "used": _mem_bytes, "keys": len(_mem)}
    r = _redis()
    if r is not None:
        try:
            mem = r.info("memory")
            server = r.info("server")
            out.update(
                backend="Redis",
                connected=True,
                version=server.get("redis_version", ""),
                used=mem.get("used_memory", 0),
                limit=mem.get("maxmemory", 0),
                keys=r.dbsize(),
            )
        except Exception as e:
            _fail(e)
    elif URL:
        out["backend"] = "memory (Redis unreachable)"
    total = stats["hits"] + stats["misses"]
    out["hit_rate"] = stats["hits"] / total if total else 0
    return out
