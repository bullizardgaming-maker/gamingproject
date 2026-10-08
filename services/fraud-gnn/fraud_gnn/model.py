"""Heterogeneous Graph Transformer (HGT) for syndicate fraud detection.

Every node type is projected into a shared hidden space, then HGT layers pass
messages along typed edges with relation-specific attention — so the model
learns, for example, that a device shared by many buyers who all pay one new
seller is far more telling than a shared /24 subnet. A linear head turns each
user embedding into a fraud probability.
"""
from __future__ import annotations

import torch
from torch import nn
from torch_geometric.data import HeteroData
from torch_geometric.nn import HGTConv


class SyndicateHGT(nn.Module):
    def __init__(self, metadata, in_dims: dict[str, int], hidden: int = 64, heads: int = 4, layers: int = 2, dropout: float = 0.2):
        super().__init__()
        self.proj = nn.ModuleDict({t: nn.Linear(d, hidden) for t, d in in_dims.items()})
        self.convs = nn.ModuleList([HGTConv(hidden, hidden, metadata, heads=heads) for _ in range(layers)])
        self.dropout = nn.Dropout(dropout)
        self.head = nn.Sequential(nn.Linear(hidden, hidden), nn.ReLU(), nn.Linear(hidden, 1))

    def forward(self, data: HeteroData) -> torch.Tensor:
        h = {t: torch.relu(self.proj[t](data[t].x)) for t in data.node_types}
        for conv in self.convs:
            out = conv(h, data.edge_index_dict)
            # Residual keeps node types without incoming edges (or isolated nodes) informative.
            h = {t: self.dropout(torch.relu(out[t])) + h[t] if out.get(t) is not None else h[t] for t in h}
        return self.head(h["user"]).squeeze(-1)  # logits


def in_dims_of(data: HeteroData) -> dict[str, int]:
    return {t: data[t].x.size(-1) for t in data.node_types}


def order_score(probs: torch.Tensor, buyer_idx: int, seller_idx: int) -> float:
    """Order-level syndicate risk: either party being part of a ring taints the order (noisy-OR)."""
    pb, ps = float(probs[buyer_idx]), float(probs[seller_idx])
    return 1 - (1 - pb) * (1 - ps)
