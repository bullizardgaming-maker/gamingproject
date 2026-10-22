-- Which data key encrypted each stored file (NULL for stores that encrypt by themselves, e.g. S3 SSE),
-- so key rotation can find files still under an old key without reading every file.
ALTER TABLE chat_attachments ADD COLUMN key_version text;
