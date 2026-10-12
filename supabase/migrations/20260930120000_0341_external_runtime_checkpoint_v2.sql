-- External runtime v2: durable accepted-response binding and job-idempotent checkpoints.

alter table public.send_ledger
  add column if not exists external_response jsonb;

comment on column public.send_ledger.external_response is
  'Validated external-runtime response bound after before-send gates and before transport; never sent to the channel.';

-- Historical retries could write more than one checkpoint for the same job.
-- Preserve every checkpoint row, but keep the newest one as the canonical
-- job-bound row so the partial uniqueness invariant can be installed safely.
with ranked as (
  select id,
         row_number() over (
           partition by organization_id, job_id
           order by seq desc
         ) as position_in_job
    from public.lead_checkpoints
   where job_id is not null
)
update public.lead_checkpoints checkpoint
   set job_id = null
  from ranked
 where checkpoint.id = ranked.id
   and ranked.position_in_job > 1;

do $migration$
begin
  if exists (
    select 1
      from public.lead_checkpoints
     where job_id is not null
     group by organization_id, job_id
    having count(*) > 1
  ) then
    raise exception 'lead_checkpoints still has duplicate organization/job bindings';
  end if;
end;
$migration$;

create unique index if not exists uq_lead_checkpoints_org_job
  on public.lead_checkpoints (organization_id, job_id)
  where job_id is not null;
