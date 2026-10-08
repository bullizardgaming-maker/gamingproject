"""Train the HGT on a graph snapshot.

    python -m fraud_gnn.train --synthetic               # bootstrap model
    python -m fraud_gnn.train --dsn postgres://...      # labelled production snapshot

Labels: users with confirmed fraud flags, fraud suspensions or charged-back
purchases. Class imbalance is handled with a positive-class weight.

On production data, validate on the newest accounts (--holdout time, the default
with --dsn): a random split leaks the future into training and overstates accuracy.
Compare the result with the API's shadow-mode report (GET /v1/admin/fraud/model-report)
before switching FRAUD_GNN_MODE to enforce.
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


def precision_recall(scores: torch.Tensor, labels: torch.Tensor, threshold: float = 0.5) -> tuple[float, float]:
    flagged = scores >= threshold
    tp = float((flagged & (labels == 1)).sum())
    precision = tp / float(flagged.sum()) if flagged.any() else float("nan")
    recall = tp / float((labels == 1).sum()) if (labels == 1).any() else float("nan")
    return precision, recall


def split_masks(raw: RawGraph, n: int, val_frac: float, holdout: str) -> torch.Tensor:
    """Validation mask: a random sample, or ("time") the newest accounts, so the check runs on users
    the model could not have seen at training time."""
    k = int(n * val_frac)
    val_mask = torch.zeros(n, dtype=torch.bool)
    if holdout == "time":
        newest = sorted(range(n), key=lambda i: raw.users[i]["age_days"])[:k]
        val_mask[newest] = True
    else:
        val_mask[torch.randperm(n)[:k]] = True
    return val_mask


def train(raw: RawGraph, epochs: int = 150, lr: float = 5e-3, seed: int = 0, val_frac: float = 0.25, holdout: str = "random"):
    torch.manual_seed(seed)
    built = build(raw)
    data = built.data
    y = data["user"].y
    n = y.numel()
    val_mask = split_masks(raw, n, val_frac, holdout)
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
    precision, recall = precision_recall(probs[val_mask], y[val_mask])
    return model, built, {
        "val_auc": roc_auc(probs[val_mask], y[val_mask]),
        "train_auc": roc_auc(probs[train_mask], y[train_mask]),
        "val_precision_at_0_5": precision,
        "val_recall_at_0_5": recall,
        "holdout": holdout,
        "val_positives": int(y[val_mask].sum()),
    }


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
    ap.add_argument("--holdout", choices=["random", "time"], help="validation split (default: time on --dsn, random on synthetic)")
    args = ap.parse_args()
    synthetic = args.synthetic or not args.dsn
    raw = generate() if synthetic else load_from_postgres(args.dsn)
    model, built, metrics = train(raw, epochs=args.epochs, holdout=args.holdout or ("random" if synthetic else "time"))
    save(model, built, args.out)
    print(f"saved {args.out}: {metrics}")


if __name__ == "__main__":
    main()
