"""Countersign vi-service (spec §8.3, WP-03).

The crypto oracle for Verifiable Intent. It **signs and verifies**; it holds no state beyond its
keys. All persistence and all authority live in Postgres behind `apps/web` (spec §3.1, §8.3).

The crypto itself is the reference `verifiable_intent` library, pinned to one commit
(``356c29635f1c44df7de02edb58699ca9f29bece6``, spec D2 / [B1]). This package is the HTTP wrapper
around it: request validation, the key registry, the two-phase L2 signing flow, and one error
contract shared with `packages/core`.
"""

from __future__ import annotations

__version__ = "1.0.0"

#: The commit of `verifiable-intent` this service is written against. Recorded in the constraint
#: fixture and in every evidence bundle (`vi_lib_commit`, spec §7.3) so a verdict can name the exact
#: verification code that produced it.
VI_LIB_COMMIT = "356c29635f1c44df7de02edb58699ca9f29bece6"

__all__ = ["VI_LIB_COMMIT", "__version__"]
