-- PostgreSQL enum values must be committed before they are used by later
-- schema objects, so this change intentionally lives in its own migration.
alter type public.record_source add value if not exists 'walk_tracking';
