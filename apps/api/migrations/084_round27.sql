-- Round 27 (2): the risk reasons in plain words, stored with the flag so Ops and the staff order view can show why.
ALTER TABLE risk_flags ADD COLUMN IF NOT EXISTS reasons_text text[] NOT NULL DEFAULT '{}';
