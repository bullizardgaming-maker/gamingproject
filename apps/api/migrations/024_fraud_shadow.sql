-- Fraud model shadow mode. Every scored order keeps the inline heuristic score and, when the
-- graph model answered, its score and version, plus which mode was in force. Outcomes are
-- labelled later (fraud: confirmed flag, fraud chargeback or fraud suspension; legit: completed
-- and past the chargeback window, or a flag staff cleared), so the two can be compared on real
-- data before the model is allowed to act.

CREATE TABLE fraud_scores (
  order_id        uuid PRIMARY KEY REFERENCES orders(id),
  heuristic_score numeric(5,4) NOT NULL,
  gnn_score       numeric(5,4),
  model_version   text,
  mode            text NOT NULL CHECK (mode IN ('off', 'shadow', 'enforce')),
  used_score      numeric(5,4) NOT NULL,       -- the score that drove the action
  created_at      timestamptz NOT NULL DEFAULT now(),
  label           text CHECK (label IN ('fraud', 'legit')),
  labelled_at     timestamptz
);
CREATE INDEX ON fraud_scores (created_at);
CREATE INDEX ON fraud_scores (created_at) WHERE label IS NULL;
