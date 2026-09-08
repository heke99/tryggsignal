-- Tryggsignal — integration test for the queue runtime the worker depends on.
--
-- Exercises exactly the calls `services/worker` makes, in the order it makes
-- them: enqueue, read, claim, complete, retry, dead-letter, and the redelivery
-- path where a job that already completed must not run a second time.
--
-- The queue functions commit through PGMQ, so this test cleans up after itself
-- explicitly rather than relying on a rollback.
--
--   psql "$DEV_DATA_PLANE_URL" -v ON_ERROR_STOP=1 -f tests/integration/worker_runtime.sql
--
-- Last verified GREEN: 2026-09-08 against the development data plane.

\set ON_ERROR_STOP on

do $$
declare
  v_queue text := 'notifications';
  v_msg_id bigint;
  v_msg record;
  v_claim boolean;
  v_dl uuid;
  v_run bigint;
  v_key text := 'worker-runtime-test-' || extensions.gen_random_uuid()::text;
  v_key2 text := 'worker-runtime-test-' || extensions.gen_random_uuid()::text;
  v_count integer;
begin
  -- 1. Enqueue through the envelope-enforcing helper -------------------------
  v_msg_id := config.enqueue_job(
    v_queue, 'workflow_timer', 'instance-1', null, v_key,
    jsonb_build_object('timer_key', 'grannhorande')
  );
  if v_msg_id is null then
    raise exception 'enqueue_job returned no message id';
  end if;

  -- The envelope contract is enforced in the database, not only in the worker.
  begin
    perform config.enqueue_job(v_queue, 'workflow_timer', 'instance-1', null, '');
    raise exception 'enqueue_job accepted an empty idempotency key';
  exception when check_violation then
    null;
  end;

  begin
    perform config.enqueue_job(v_queue, 'workflow_timer', '', null, 'k');
    raise exception 'enqueue_job accepted an empty tenant context';
  exception when check_violation then
    null;
  end;

  -- 2. Read it back the way the worker does ---------------------------------
  select * into v_msg from config.read_jobs(v_queue, 30, 10)
   where (envelope ->> 'idempotency_key') = v_key;
  if v_msg is null then
    raise exception 'read_jobs did not return the enqueued message';
  end if;
  if v_msg.envelope ->> 'type' <> 'workflow_timer' then
    raise exception 'envelope type was not preserved: %', v_msg.envelope ->> 'type';
  end if;
  if v_msg.envelope ->> 'tenant_context' <> 'instance-1' then
    raise exception 'envelope tenant context was not preserved';
  end if;
  if (v_msg.envelope -> 'payload' ->> 'timer_key') <> 'grannhorande' then
    raise exception 'envelope payload was not preserved';
  end if;

  -- A second read inside the visibility window must not hand out the same
  -- message again — that is what stops two workers doing the same job.
  perform 1 from config.read_jobs(v_queue, 30, 10)
   where (envelope ->> 'idempotency_key') = v_key;
  if found then
    raise exception 'read_jobs handed out an invisible message a second time';
  end if;

  -- 3. Claim, then complete --------------------------------------------------
  v_claim := config.claim_job(v_queue, v_key, (v_msg.envelope ->> 'job_id')::uuid, 'instance-1');
  if not v_claim then
    raise exception 'claim_job refused a job that has never run';
  end if;

  perform config.complete_job(
    v_queue, v_msg.msg_id, v_key, (v_msg.envelope ->> 'job_id')::uuid, 'instance-1'
  );

  select count(*) into v_count from config.processed_jobs
   where queue_name = v_queue and idempotency_key = v_key;
  if v_count <> 1 then
    raise exception 'complete_job did not record the job in the ledger';
  end if;

  -- 4. Redelivery: the same key must never run twice -------------------------
  v_claim := config.claim_job(v_queue, v_key, (v_msg.envelope ->> 'job_id')::uuid, 'instance-1');
  if v_claim then
    raise exception 'claim_job allowed a redelivery of an already completed job';
  end if;

  -- 5. Retry puts the message back, invisible until the delay elapses --------
  v_msg_id := config.enqueue_job(
    v_queue, 'workflow_timer', 'instance-2', null, v_key2, jsonb_build_object()
  );
  select * into v_msg from config.read_jobs(v_queue, 30, 10)
   where (envelope ->> 'idempotency_key') = v_key2;
  if v_msg is null then
    raise exception 'read_jobs did not return the second message';
  end if;

  perform config.retry_job(v_queue, v_msg.msg_id, 120);
  perform 1 from config.read_jobs(v_queue, 30, 10)
   where (envelope ->> 'idempotency_key') = v_key2;
  if found then
    raise exception 'retry_job left the message visible';
  end if;

  -- 6. Heartbeat extends the lease -------------------------------------------
  perform config.heartbeat_job(v_queue, v_msg.msg_id, 300);

  -- 7. Dead-letter copies the envelope out and clears the queue --------------
  v_dl := config.dead_letter_job(
    v_queue, v_msg.msg_id, v_msg.envelope, 8, 'Exhausted 8 attempts: integration test'
  );
  if v_dl is null then
    raise exception 'dead_letter_job returned no id';
  end if;

  select count(*) into v_count from config.dead_letter_jobs
   where id = v_dl
     and queue_name = v_queue
     and idempotency_key = v_key2
     and job_type = 'workflow_timer'
     and attempts = 8
     and resolved_at is null;
  if v_count <> 1 then
    raise exception 'dead_letter_jobs row was not written as expected';
  end if;

  perform 1 from config.read_jobs(v_queue, 5, 10)
   where (envelope ->> 'idempotency_key') = v_key2;
  if found then
    raise exception 'dead_letter_job left the message on the queue';
  end if;

  -- 8. Run log ---------------------------------------------------------------
  v_run := config.start_worker_run('integration-test', v_queue);
  perform config.finish_worker_run(v_run, 1, 0, 1, 0, null);
  select count(*) into v_count from config.worker_runs
   where id = v_run and finished_at is not null and processed = 1 and dead_lettered = 1;
  if v_count <> 1 then
    raise exception 'worker run was not recorded';
  end if;

  -- Clean up ------------------------------------------------------------------
  delete from config.dead_letter_jobs where id = v_dl;
  delete from config.processed_jobs where idempotency_key in (v_key, v_key2);
  delete from config.worker_runs where id = v_run;

  raise notice 'GREEN — worker queue runtime';
end
$$;
