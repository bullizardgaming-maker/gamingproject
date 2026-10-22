-- Seller onboarding: a rules test gates the first listing; identity verification is due within
-- 30 days of starting to sell, after which selling (and withdrawals) are restricted until done.

CREATE TABLE rules_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position    integer NOT NULL,
  question    text NOT NULL,
  options     jsonb NOT NULL,          -- ["A", "B", "C", "D"]
  correct     integer NOT NULL,        -- index into options
  explanation text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rules_settings (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  pass_mark_pct integer NOT NULL DEFAULT 100 CHECK (pass_mark_pct BETWEEN 1 AND 100),
  id_due_days   integer NOT NULL DEFAULT 30 CHECK (id_due_days BETWEEN 1 AND 365),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO rules_settings DEFAULT VALUES;

INSERT INTO rules_questions (position, question, options, correct, explanation) VALUES
  (1, 'A buyer asks you to finish the trade on Discord so you both skip the fee. What do you do?',
      '["Agree, it saves money", "Decline and keep the whole trade in the Bullizard order chat", "Share your Discord but trade here", "Ask them to pay half outside"]', 1,
      'Trading or sharing outside contacts anywhere on Bullizard can get your account banned right away. Everything stays in the order chat.'),
  (2, 'When does the payment reach your balance?',
      '["The moment the buyer pays", "When you mark the order delivered", "When the buyer confirms delivery, or staff release it after review", "After 72 hours automatically"]', 2,
      'The payment is held in escrow until the buyer confirms. There is no automatic release; staff can release an unconfirmed order after review, never before 24 hours.'),
  (3, 'What must you attach before marking an in-game delivery as delivered?',
      '["Nothing", "A photo or video of the trade (proof of delivery)", "The buyer''s email", "A screenshot of your inventory"]', 1,
      'Proof of delivery is required for currency, items, top-ups and boosting. It is what staff look at in a dispute.'),
  (4, 'Which price do you enter on the sell form?',
      '["The price you want to receive; the commission is added on top for the buyer", "The buyer price; the commission is taken out", "Any price plus the withdrawal fee", "The price in the buyer''s currency"]', 0,
      'You set your price and receive it in full. The buyer sees it with your rank''s commission added on top.'),
  (5, 'A buyer''s character name on the order is wrong and the trade fails. What do you do?',
      '["Deliver to any character with a similar name", "Message the buyer in the order chat and wait; do not deliver elsewhere", "Cancel and ask them to pay you directly", "Mark it delivered anyway"]', 1,
      'The buyer confirmed the name and is responsible for it. Sort it out in the order chat, or open a dispute; never deliver to another name.'),
  (6, 'What happens on a third off-platform warning?',
      '["Nothing", "A listing is removed", "Your account is banned automatically and reviewed by staff", "You pay a fee"]', 2,
      'First and second offences are warnings; the third bans the account automatically pending staff review.');

ALTER TABLE users ADD COLUMN rules_passed_at timestamptz;
ALTER TABLE users ADD COLUMN rules_attempts integer NOT NULL DEFAULT 0;
-- Set when identity verification is overdue: listings are paused and selling stops until Tier 2.
ALTER TABLE users ADD COLUMN selling_restricted_at timestamptz;
ALTER TABLE users ADD COLUMN id_reminders_sent integer NOT NULL DEFAULT 0;
