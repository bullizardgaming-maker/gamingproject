"""Scoring service called by the API (FRAUD_GNN_URL) on every captured payment.

    uvicorn fraud_gnn.service:app --port 8090

The graph snapshot is rebuilt from Postgres every REFRESH_SECONDS, and on
demand when an order involves a user that is not in the snapshot yet. In shadow
mode the API only records this score next to its own; in enforce mode it blends
them (taking the max). It falls back to the heuristic alone if this service is
slow or down. Every score carries the model version, so the API's comparison
report can tell models apart.
"""
from __future__ import annotations

import hashlib
import os
import threading
import time
from typing import Callable

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .graph import BuiltGraph, RawGraph, build, load_from_postgres, order_parties
from .model import SyndicateHGT, order_score
from .train import load


class ScoreRequest(BaseModel):
    order_id: str | None = None
    buyer_id: str | None = None
    seller_id: str | None = None


class GraphCache:
    def __init__(self, loader: Callable[[], RawGraph], model: SyndicateHGT, refresh_seconds: float):
        self.loader, self.model, self.refresh_seconds = loader, model, refresh_seconds
        self.lock = threading.Lock()
        self.built: BuiltGraph | None = None
        self.probs: torch.Tensor | None = None
        self.at = 0.0

    def refresh(self) -> None:
        built = build(self.loader())
        with torch.no_grad():
            probs = torch.sigmoid(self.model(built.data))
        with self.lock:
            self.built, self.probs, self.at = built, probs, time.time()

    def get(self, *user_ids: str) -> tuple[BuiltGraph, torch.Tensor]:
        stale = self.built is None or time.time() - self.at > self.refresh_seconds
        missing = self.built is not None and any(u not in self.built.user_index for u in user_ids)
        if stale or missing:
            self.refresh()
        assert self.built is not None and self.probs is not None
        return self.built, self.probs


def model_version(path: str) -> str:
    """MODEL_VERSION if set, else the first 12 hex digits of the checkpoint's SHA-256."""
    if os.environ.get("MODEL_VERSION"):
        return os.environ["MODEL_VERSION"]
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:12]


def create_app(cache: GraphCache, parties: Callable[[str], tuple[str, str] | None], version: str = "unknown") -> FastAPI:
    app = FastAPI(title="Syndicate risk (HGT)")

    @app.get("/healthz")
    def healthz():
        return {"ok": True, "model_version": version, "snapshot_age_s": time.time() - cache.at if cache.at else None}

    @app.post("/score")
    def score(req: ScoreRequest):
        if req.order_id:
            p = parties(req.order_id)
            if not p:
                raise HTTPException(404, "order not found")
            buyer, seller = p
        elif req.buyer_id and req.seller_id:
            buyer, seller = req.buyer_id, req.seller_id
        else:
            raise HTTPException(400, "order_id or buyer_id+seller_id required")
        built, probs = cache.get(buyer, seller)
        if buyer not in built.user_index or seller not in built.user_index:
            raise HTTPException(404, "user not in graph")
        b, s = built.user_index[buyer], built.user_index[seller]
        value = order_score(probs, b, s)
        return {
            "score": round(value, 4),
            "model_version": version,
            "reasons": [
                {"code": "gnn_buyer_ring_probability", "weight": round(float(probs[b]), 4)},
                {"code": "gnn_seller_ring_probability", "weight": round(float(probs[s]), 4)},
            ],
        }

    return app


def _default_app() -> FastAPI:
    dsn = os.environ.get("DATABASE_URL", "postgres://market:market@localhost:5432/market")
    path = os.environ.get("MODEL_PATH", "models/hgt.pt")
    model = load(path)
    cache = GraphCache(lambda: load_from_postgres(dsn), model, float(os.environ.get("REFRESH_SECONDS", "300")))
    return create_app(cache, lambda oid: order_parties(dsn, oid), model_version(path))


def __getattr__(name: str):
    # Lazily build `app` so importing this module (e.g. in tests) needs no DB or model file.
    if name == "app":
        return _default_app()
    raise AttributeError(name)
