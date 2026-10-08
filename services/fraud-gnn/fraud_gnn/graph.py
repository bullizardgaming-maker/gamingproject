"""Heterogeneous marketplace graph.

Nodes:  user, device, subnet, card, wallet
Edges:  user -uses-> device, user -seen_on-> subnet, user -pays_with-> card,
        user -owns-> wallet, user -buys_from-> user   (+ reverse edges)

The same tables the API writes (risk_signals, orders, users, risk_flags) are
read here, so the model sees exactly the infrastructure-sharing structure the
real-time heuristic uses — but learns how much each relation matters.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import torch
import torch_geometric.transforms as T
from torch_geometric.data import HeteroData

ENTITY_KINDS = {"device": "uses", "ip_subnet": "seen_on", "card": "pays_with", "wallet": "owns"}
ENTITY_NODE = {"device": "device", "ip_subnet": "subnet", "card": "card", "wallet": "wallet"}
USER_FEATURES = 7


@dataclass
class RawGraph:
    """Plain-Python graph snapshot, independent of where it came from (DB or synthetic)."""

    users: list[dict] = field(default_factory=list)  # {id, age_days, kyc_tier, label}
    signals: list[tuple[str, str, str]] = field(default_factory=list)  # (user_id, kind, value)
    orders: list[tuple[str, str, float]] = field(default_factory=list)  # (buyer_id, seller_id, hours_ago)


@dataclass
class BuiltGraph:
    data: HeteroData
    user_index: dict[str, int]


def build(raw: RawGraph) -> BuiltGraph:
    user_index = {u["id"]: i for i, u in enumerate(raw.users)}
    n = len(raw.users)

    bought = [0] * n
    sold = [0] * n
    recent = [0] * n
    sellers_of: list[set[int]] = [set() for _ in range(n)]
    buyers_of: list[set[int]] = [set() for _ in range(n)]
    buy_edges: list[tuple[int, int]] = []
    for buyer, seller, hours_ago in raw.orders:
        if buyer not in user_index or seller not in user_index:
            continue
        b, s = user_index[buyer], user_index[seller]
        bought[b] += 1
        sold[s] += 1
        if hours_ago <= 72:
            recent[b] += 1
            recent[s] += 1
        sellers_of[b].add(s)
        buyers_of[s].add(b)
        buy_edges.append((b, s))

    x_user = torch.tensor(
        [
            [
                math.log1p(u["age_days"]),
                u["kyc_tier"] / 2,
                math.log1p(bought[i]),
                math.log1p(sold[i]),
                math.log1p(len(sellers_of[i])),
                math.log1p(len(buyers_of[i])),
                recent[i] / max(1, bought[i] + sold[i]),
            ]
            for i, u in enumerate(raw.users)
        ],
        dtype=torch.float,
    ).reshape(n, USER_FEATURES)

    data = HeteroData()
    data["user"].x = x_user
    data["user"].y = torch.tensor([float(u.get("label", 0)) for u in raw.users])

    for kind, rel in ENTITY_KINDS.items():
        node = ENTITY_NODE[kind]
        values: dict[str, int] = {}
        src, dst = [], []
        for user_id, k, value in raw.signals:
            if k != kind or user_id not in user_index:
                continue
            j = values.setdefault(value, len(values))
            src.append(user_index[user_id])
            dst.append(j)
        degree = torch.zeros(max(1, len(values)))
        for j in dst:
            degree[j] += 1
        # Entity feature: how many accounts share it. A device shared by 12 buyers is the signal.
        data[node].x = torch.log1p(degree).unsqueeze(1)
        data["user", rel, node].edge_index = torch.tensor([src, dst], dtype=torch.long).reshape(2, -1)

    data["user", "buys_from", "user"].edge_index = torch.tensor(buy_edges, dtype=torch.long).t().reshape(2, -1)
    data = T.ToUndirected()(data)
    return BuiltGraph(data=data, user_index=user_index)


def load_from_postgres(dsn: str) -> RawGraph:
    """Snapshot the live marketplace graph (read-only)."""
    import psycopg

    raw = RawGraph()
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT u.id::text,
                   EXTRACT(EPOCH FROM now() - u.created_at) / 86400,
                   u.kyc_tier,
                   (COALESCE(u.suspension_reason = 'fraud_confirmed', false)
                    OR EXISTS (SELECT 1 FROM risk_flags f WHERE f.user_id = u.id AND f.status = 'confirmed')
                    OR EXISTS (SELECT 1 FROM orders o WHERE o.buyer_id = u.id AND o.status = 'charged_back'))::int
              FROM users u
            """
        )
        raw.users = [{"id": r[0], "age_days": float(r[1]), "kyc_tier": r[2], "label": r[3]} for r in cur.fetchall()]
        cur.execute("SELECT user_id::text, kind, value FROM risk_signals")
        raw.signals = [tuple(r) for r in cur.fetchall()]
        cur.execute(
            """
            SELECT buyer_id::text, seller_id::text, EXTRACT(EPOCH FROM now() - COALESCE(paid_at, created_at)) / 3600
              FROM orders WHERE status NOT IN ('awaiting_payment', 'cancelled')
            """
        )
        raw.orders = [(r[0], r[1], float(r[2])) for r in cur.fetchall()]
    return raw


def order_parties(dsn: str, order_id: str) -> tuple[str, str] | None:
    import psycopg

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT buyer_id::text, seller_id::text FROM orders WHERE id = %s", (order_id,))
        row = cur.fetchone()
        return (row[0], row[1]) if row else None
