"""Synthetic marketplace graphs with planted fraud rings.

Used to bootstrap a model before enough labelled production data exists, and
in tests. Legitimate users mostly have their own device and card and buy from
established sellers; rings are clusters of fresh buyer accounts that share a
handful of devices / proxy subnets / cards and funnel purchases into one new
seller within 72 hours.
"""
from __future__ import annotations

import random

from .graph import RawGraph


def generate(n_legit: int = 400, n_rings: int = 12, ring_size: tuple[int, int] = (4, 9), seed: int = 0) -> RawGraph:
    rnd = random.Random(seed)
    g = RawGraph()
    uid = 0
    age_of: dict[str, float] = {}

    def new_user(age: float, tier: int, label: int) -> str:
        nonlocal uid
        uid += 1
        user_id = f"u{uid}"
        g.users.append({"id": user_id, "age_days": age, "kyc_tier": tier, "label": label})
        age_of[user_id] = age
        return user_id

    # Account age alone must not separate the classes: plenty of honest users and sellers are brand new.
    def legit_age() -> float:
        return rnd.uniform(0, 3) if rnd.random() < 0.35 else rnd.uniform(3, 1500)

    # Long tail: a few big shops and many small ones with a handful of buyers (like a real marketplace).
    sellers = [new_user(legit_age(), 2, 0) for _ in range(max(10, n_legit // 5))]
    popularity = [1 / (i + 1) ** 1.1 for i in range(len(sellers))]
    # Signals are sometimes missing (private IPs, cleared storage), for honest and fraudulent users alike.
    def maybe(p: float = 0.8) -> bool:
        return rnd.random() < p

    for s in sellers:
        g.signals.append((s, "device", f"dev-{s}"))
        if maybe():
            g.signals.append((s, "ip_subnet", f"net-{rnd.randrange(200)}"))

    for _ in range(n_legit):
        u = new_user(legit_age(), rnd.choice([1, 1, 1, 2]), 0)
        g.signals.append((u, "device", f"dev-{u}"))
        if rnd.random() < 0.3:  # households / phones: occasional shared device
            g.signals.append((u, "device", f"dev-shared-{rnd.randrange(n_legit // 3)}"))
        if maybe():
            g.signals.append((u, "ip_subnet", f"net-{rnd.randrange(200)}"))  # ISPs: subnets overlap innocently
        g.signals.append((u, "card", f"card-{u}"))
        for _ in range(rnd.randint(0, 6)):
            seller = rnd.choices(sellers, weights=popularity)[0]
            # An order can't be older than either account, so honest newcomers look "all recent" too.
            window = min(age_of[u], age_of[seller], 90) * 24
            g.orders.append((u, seller, rnd.uniform(0, window)))

    # Honest cold start: brand-new sellers whose first few buyers are also new but fully independent
    # (own device, own card). Structurally the opposite of a ring, despite the same account ages.
    for _ in range(max(10, n_legit // 8)):
        shop = new_user(rnd.uniform(0, 2), 2, 0)
        g.signals.append((shop, "device", f"dev-{shop}"))
        for _ in range(rnd.randint(1, 5)):
            b = new_user(rnd.uniform(0, 2), 1, 0)
            g.signals.append((b, "device", f"dev-{b}"))
            g.signals.append((b, "card", f"card-{b}"))
            if maybe():
                g.signals.append((b, "ip_subnet", f"net-{rnd.randrange(200)}"))
            g.orders.append((b, shop, rnd.uniform(0, 24)))

    for r in range(n_rings):
        mule = new_user(rnd.uniform(0.5, 30), 2, 1)
        g.signals.append((mule, "device", f"ring{r}-dev-0"))
        if maybe():
            g.signals.append((mule, "ip_subnet", f"net-{rnd.randrange(200)}"))
        size = rnd.randint(*ring_size)
        devices = [f"ring{r}-dev-{i}" for i in range(rnd.randint(1, 3))]
        subnet = f"ring{r}-proxy"
        cards = [f"ring{r}-card-{i}" for i in range(rnd.randint(2, 5))]
        for _ in range(size):
            b = new_user(rnd.uniform(0, 10), 1, 1)
            g.signals.append((b, "device", rnd.choice(devices)))
            if maybe():
                g.signals.append((b, "ip_subnet", subnet))
            g.signals.append((b, "card", rnd.choice(cards)))
            for _ in range(rnd.randint(1, 3)):
                g.orders.append((b, mule, rnd.uniform(0, 72)))
            if rnd.random() < 0.3:  # rings also buy a little elsewhere to look normal
                g.orders.append((b, rnd.choice(sellers), rnd.uniform(0, 72)))
    return g
