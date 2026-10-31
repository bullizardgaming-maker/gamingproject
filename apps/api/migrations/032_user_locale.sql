-- The language a user reads Bullizard in: emails, in-app notifications, push and SMS follow it.
ALTER TABLE users ADD COLUMN locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ar', 'es', 'fr', 'de', 'pt'));
