-- Tryggsignal P2 — durable job infrastructure.
-- Masterplan 42/45: PGMQ for durable queues, pg_cron only for small scheduled
-- triggers that enqueue work rather than performing it.
create extension if not exists pgmq;
create extension if not exists pg_cron;
