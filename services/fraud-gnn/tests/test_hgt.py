import pytest
import torch
from fastapi.testclient import TestClient

from fraud_gnn.graph import build
from fraud_gnn.model import SyndicateHGT, in_dims_of
from fraud_gnn.service import GraphCache, create_app
from fraud_gnn.synthetic import generate
from fraud_gnn.train import load, roc_auc, save, train


def test_graph_shapes():
    raw = generate(n_legit=50, n_rings=3, seed=1)
    built = build(raw)
    d = built.data
    assert set(d.node_types) == {"user", "device", "subnet", "card", "wallet"}
    assert ("device", "rev_uses", "user") in d.edge_types  # reverse edges for message passing
    assert d["user"].x.shape == (len(raw.users), 7)
    model = SyndicateHGT(d.metadata(), in_dims_of(d))
    assert model(d).shape == (len(raw.users),)


def test_roc_auc():
    assert roc_auc(torch.tensor([0.9, 0.8, 0.1, 0.2]), torch.tensor([1.0, 1.0, 0.0, 0.0])) == 1.0
    assert roc_auc(torch.tensor([0.1, 0.9]), torch.tensor([1.0, 0.0])) == 0.0


def test_learns_to_separate_rings_from_legit_users():
    model, built, metrics = train(generate(seed=0), epochs=120)
    assert metrics["val_auc"] > 0.9, metrics


def test_service_scores_ring_orders_above_legit_orders(tmp_path):
    raw = generate(seed=3)
    model, built, _ = train(raw, epochs=120)
    path = tmp_path / "hgt.pt"
    save(model, built, str(path))
    cache = GraphCache(lambda: raw, load(str(path)), refresh_seconds=3600)

    ring_order = next(o for o in raw.orders if o[0] in {u["id"] for u in raw.users if u["label"]})
    legit_order = next(o for o in raw.orders if o[0] in {u["id"] for u in raw.users if not u["label"]})
    orders = {"ring": ring_order[:2], "legit": legit_order[:2]}
    client = TestClient(create_app(cache, lambda oid: orders.get(oid)))

    ring = client.post("/score", json={"order_id": "ring"}).json()
    legit = client.post("/score", json={"order_id": "legit"}).json()
    assert ring["score"] > 0.8 > legit["score"], (ring, legit)
    assert client.post("/score", json={"order_id": "nope"}).status_code == 404
    assert client.get("/healthz").json()["ok"] is True


@pytest.mark.parametrize("seed", [10, 11, 13, 14, 15])
def test_new_but_honest_accounts_are_not_flagged(seed):
    """Guards against the model learning 'young account = fraud' instead of ring structure."""
    raw = generate(seed=seed)
    model, built, _ = train(raw, epochs=120, seed=seed)
    # A fresh buyer with their own device and card, buying once from a fresh seller.
    raw.users += [{"id": "newbuyer", "age_days": 0.01, "kyc_tier": 1, "label": 0}, {"id": "newseller", "age_days": 0.01, "kyc_tier": 2, "label": 0}]
    raw.signals += [("newbuyer", "device", "nb-dev"), ("newbuyer", "card", "nb-card"), ("newseller", "device", "ns-dev")]
    raw.orders += [("newbuyer", "newseller", 1.0)]
    b2 = build(raw)
    model.eval()
    with torch.no_grad():
        probs = torch.sigmoid(model(b2.data))
    assert float(probs[b2.user_index["newbuyer"]]) < 0.5
    assert float(probs[b2.user_index["newseller"]]) < 0.5
