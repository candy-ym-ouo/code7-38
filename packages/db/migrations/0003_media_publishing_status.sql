-- Intermediate state claimed by a single publisher while public objects are
-- being copied. The transition manual_review/processing -> publishing is an
-- atomic conditional UPDATE so concurrent privacy confirmations and worker
-- jobs cannot publish the same media twice.
ALTER TYPE media_status ADD VALUE IF NOT EXISTS 'publishing';
