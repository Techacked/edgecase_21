"""In-memory store (demo policies are re-seeded on every start). Swap for a DB later if needed."""
from __future__ import annotations

import json
import threading
from pathlib import Path

from .catalog import DEFAULT_SLUG, fresh_catalog
from .config import settings


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
        self.datasets: dict[str, dict] = {}
        self.policies_path = settings.storage_dir / "policies.json"
        self.datasets_path = settings.storage_dir / "datasets.json"
        self._load_custom_policies()
        self._load_datasets()
        for p in self.policies.values():
            self.stamp(p)

    def _read_list(self, path: Path) -> list[dict]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return value if isinstance(value, list) else []
        except (OSError, json.JSONDecodeError):
            return []

    def _write_list(self, path: Path, values: list[dict]) -> None:
        temp = path.with_suffix(path.suffix + ".tmp")
        temp.write_text(json.dumps(values, ensure_ascii=False), encoding="utf-8")
        temp.replace(path)

    def _load_custom_policies(self) -> None:
        for policy in self._read_list(self.policies_path):
            if isinstance(policy, dict) and policy.get("slug") and policy.get("sourceType") != "DEMO":
                self.policies[policy["slug"]] = policy

    def _load_datasets(self) -> None:
        for dataset in self._read_list(self.datasets_path):
            if isinstance(dataset, dict) and dataset.get("id"):
                self.datasets[dataset["id"]] = dataset

    def _save_custom_policies(self) -> None:
        values = [p for p in self.policies.values() if p.get("sourceType") != "DEMO"]
        self._write_list(self.policies_path, values)

    def _save_datasets(self) -> None:
        self._write_list(self.datasets_path, list(self.datasets.values()))

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
            self._save_custom_policies()

    def add_dataset(self, dataset: dict) -> None:
        with self.lock:
            self.datasets[dataset["id"]] = dataset
            self._save_datasets()

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
