INSERT INTO categories (slug, name, kind, risk_class, promo_rate_bps) VALUES
  ('accounts',     'Game Accounts',       'account',    'high',     NULL),
  ('currency',     'In-Game Currency',    'currency',   'standard', NULL),
  ('items',        'In-Game Items',       'item',       'standard', NULL),
  ('keys',         'Software & CD Keys',  'key',        'standard', NULL),
  ('boosting',     'Boosting Services',   'boosting',   'standard', NULL),
  ('gift-cards',   'Gift Cards',          'gift_card',  'standard', 499),
  ('top-ups',      'Mobile Top-ups',      'topup',      'standard', 499),
  ('video-games',  'Video Games',         'video_game', 'standard', 499);
