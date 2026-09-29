"""EDGECASE API entrypoint:  uvicorn app.main:app --reload --port 8000"""
from __future__ import annotations

import logging
import threading
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import ai
from .api import ensure_baseline, router
from .config import settings
from .store import AppError, store

log = logging.getLogger("edgecase")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def _warm() -> None:
    for slug in list(store.policies):
        try:
            ensure_baseline(slug)
        except Exception:
            log.exception("baseline warm-up failed for %s", slug)


@asynccontextmanager
async def lifespan(_: FastAPI):
    threading.Thread(target=_warm, daemon=True).start()   # first page load is instant
    log.info("EDGECASE API ready · AI provider: %s", ai.provider())
    yield


app = FastAPI(title="EDGECASE API", version="2.0.0", description="Policy crash-testing engine (FastAPI)", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"], expose_headers=["Content-Disposition", "X-Request-Id"])


def _err(status: int, code: str, message: str, details=None, rid: str | None = None):
    body = {"success": False, "error": {"code": code, "message": message, **({"details": details} if details else {})}}
    return JSONResponse(body, status_code=status, headers={"X-Request-Id": rid or uuid.uuid4().hex[:12]})


@app.exception_handler(AppError)
async def _app_error(_: Request, exc: AppError):
    return _err(exc.status, exc.code, exc.message, exc.details)


@app.exception_handler(RequestValidationError)
async def _validation(_: Request, exc: RequestValidationError):
    details = [{"field": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]} for e in exc.errors()]
    return _err(400, "VALIDATION_ERROR", "Request validation failed", details)


@app.exception_handler(Exception)
async def _unhandled(_: Request, exc: Exception):
    log.exception("unhandled error")
    return _err(500, "INTERNAL_ERROR", "Something went wrong on the server.")


@app.get("/health")
@app.get("/api/v1/health")
def health():
    return {"success": True, "data": {"status": "ok", "aiProvider": ai.provider(), "policies": len(store.policies),
                                      "simulations": len(store.sims)}}


app.include_router(router)
