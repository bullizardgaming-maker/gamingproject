"""Train the HGT on a graph snapshot.

    python -m fraud_gnn.train --synthetic               # bootstrap model
    python -m fraud_gnn.train --dsn postgres://...      # labelled production snapshot

Labels: users with confirmed fraud flags, fraud suspensions or charged-back
purchases. Class imbalance is handled with a positive-class weight.
"""
from __future__ import annotations

import argparse

import torch
from torch import nn

from .graph import RawGraph, build, load_from_postgres
from .model import SyndicateHGT, in_dims_of
from .synthetic import generate


def roc_auc(scores: torch.Tensor, labels: torch.Tensor) -> float:
    """Mann-Whitney AUC (no sklearn dependency)."""
    pos, neg = scores[labels == 1], scores[labels == 0]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    wins = (pos.unsqueeze(1) > neg.unsqueeze(0)).float().sum() + 0.5 * (pos.unsqueeze(1) == neg.unsqueeze(0)).float().sum()
    return float(wins / (len(pos) * len(neg)))


def train(raw: RawGraph, epochs: int = 150, lr: float = 5e-3, seed: int = 0, val_frac: float = 0.25):
    torch.manual_seed(seed)
    built = build(raw)
    data = built.data
    y = data["user"].y
    n = y.numel()
    perm = torch.randperm(n)
    val_mask = torch.zeros(n, dtype=torch.bool)
    val_mask[perm[: int(n * val_frac)]] = True
    train_mask = ~val_mask

    model = SyndicateHGT(data.metadata(), in_dims_of(data))
    pos = y[train_mask].sum().clamp(min=1)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=(train_mask.sum() - pos) / pos)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)

    for epoch in range(epochs):
        model.train()
        opt.zero_grad()
        loss = loss_fn(model(data)[train_mask], y[train_mask])
        loss.backward()
        opt.step()

    model.eval()
    with torch.no_grad():
        probs = torch.sigmoid(model(data))
    return model, built, {"val_auc": roc_auc(probs[val_mask], y[val_mask]), "train_auc": roc_auc(probs[train_mask], y[train_mask])}


def save(model: SyndicateHGT, built, path: str) -> None:
    torch.save({"state_dict": model.state_dict(), "metadata": built.data.metadata(), "in_dims": in_dims_of(built.data)}, path)


def load(path: str) -> SyndicateHGT:
    ckpt = torch.load(path, weights_only=False)
    model = SyndicateHGT(ckpt["metadata"], ckpt["in_dims"])
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    return model


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn")
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--epochs", type=int, default=150)
    ap.add_argument("--out", default="models/hgt.pt")
    args = ap.parse_args()
    raw = generate() if args.synthetic or not args.dsn else load_from_postgres(args.dsn)
    model, built, metrics = train(raw, epochs=args.epochs)
    save(model, built, args.out)
    print(f"saved {args.out}: {metrics}")


if __name__ == "__main__":
    main()
