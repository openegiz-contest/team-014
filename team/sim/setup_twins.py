#!/usr/bin/env python3
"""Create (or recreate) every Bolashak twin in Ditto. Idempotent PUTs in
parent-first order; a re-run resets the twins to their initial state."""

import logging
import sys
import time
import urllib.error

from minecore import ditto, twins

log = logging.getLogger("setup")


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    bodies = twins.thing_bodies()
    for tid, body in bodies.items():
        for attempt in range(40):
            try:
                status, _ = ditto.http("PUT", f"/api/2/things/{tid}", body)
                log.info("%s %s", "created" if status == 201 else "updated", tid)
                break
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode(errors="replace")[:300]
                if exc.code < 500 and exc.code not in (404, 408, 429):
                    log.error("FAILED %s: HTTP %s %s", tid, exc.code, detail)
                    return 1
                time.sleep(3)
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
                if attempt == 39:
                    log.error("FAILED %s: %s", tid, exc)
                    return 1
                time.sleep(3)
    log.info("%d twins ready", len(bodies))
    return 0


if __name__ == "__main__":
    sys.exit(main())
