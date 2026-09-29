"""In-memory store (demo policies are re-seeded on every start). Swap for a DB later if needed."""
from __future__ import annotations

import threading

from .catalog import DEFAULT_SLUG, fresh_catalog


class AppError(Exception):
    def __init__(self, message: str, code: str = "INTERNAL_ERROR", status: int = 500, details=None):
        super().__init__(message)
        self.message, self.code, self.status, self.details = message, code, status, details


def not_found(what: str) -> AppError:
    return AppError(f"{what} not found", "NOT_FOUND", 404)


class Store:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.policies: dict[str, dict] = fresh_catalog()
        self.sims: dict[str, dict] = {}
        self.latest: dict[str, str] = {}
        self.reports: dict[str, dict] = {}
        for p in self.policies.values():
            self.stamp(p)

    @staticmethod
    def stamp(policy: dict) -> None:
        for i, r in enumerate(policy["rules"]):
            r.setdefault("id", f"{policy['slug']}-{r['code']}")
            r["orderIndex"] = i
        policy["updatedAt"] = policy["createdAt"]

    def policy(self, slug: str | None) -> dict:
        slug = slug or DEFAULT_SLUG
        if slug not in self.policies:
            raise not_found(f"Policy '{slug}'")
        return self.policies[slug]

    def add_policy(self, policy: dict) -> None:
        with self.lock:
            self.stamp(policy)
            self.policies[policy["slug"]] = policy

    def add_sim(self, sim: dict) -> None:
        with self.lock:
            self.sims[sim["id"]] = sim
            self.latest[sim["policySlug"]] = sim["id"]

    def sim(self, sim_id: str) -> dict:
        if sim_id not in self.sims:
            raise not_found("Simulation")
        return self.sims[sim_id]

    def latest_sim(self, slug: str) -> dict | None:
        sid = self.latest.get(slug)
        return self.sims.get(sid) if sid else None


store = Store()
