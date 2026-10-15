-- Durable voice artifact and conservative send-attempt fence. No backfill or HTTP.
-- Existing text ledger rows stay NULL and retain their retry semantics.
alter table public.send_ledger add column if not exists voice_delivery jsonb;

create or replace function public.fn_voice_delivery_guard() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public
as $fn$
declare v jsonb;
begin
  if tg_op = 'DELETE' then
    if old.voice_delivery is not null and current_user in ('anon','authenticated','authenticator') then
      raise exception 'voice_delivery_server_only' using errcode='42501';
    end if;
    return old;
  end if;
  v := new.voice_delivery;
  if v is null and (tg_op = 'INSERT' or old.voice_delivery is null) then return new; end if;
  if current_user in ('anon','authenticated','authenticator') then
    raise exception 'voice_delivery_server_only' using errcode='42501';
  end if;
  if v is null or jsonb_typeof(v) is distinct from 'object'
     or (v->>'state') is null or (v->>'state') not in ('reserved','preparing','ready','attempted')
     or jsonb_typeof(v->'voice') is distinct from 'object'
     or (v#>>'{voice,language}') is null or (v#>>'{voice,language}') not in ('ml','en')
     or (v#>>'{voice,inboundMessageId}') is null then
    raise exception 'voice_delivery_invalid' using errcode='23514';
  end if;
  if tg_op = 'INSERT' then
    if v->>'state' <> 'reserved' or v ? 'artifact' then
      raise exception 'voice_delivery_invalid_initial_state' using errcode='23514';
    end if;
  elsif old.voice_delivery is null then
    raise exception 'voice_delivery_cannot_adopt_legacy_intent' using errcode='23514';
  else
    if new.id <> old.id or new.organization_id <> old.organization_id
       or new.job_id <> old.job_id or new.seq <> old.seq
       or new.contact_id is distinct from old.contact_id or new.body_hash <> old.body_hash
       or new.external_response is distinct from old.external_response
       or (v->'voice') is distinct from (old.voice_delivery->'voice') then
      raise exception 'voice_delivery_identity_immutable' using errcode='23514';
    end if;
    if v is distinct from old.voice_delivery and (
      (old.voice_delivery->>'state'='reserved' and v->>'state'='preparing' and not (v ? 'artifact')) or
      (old.voice_delivery->>'state'='preparing' and v->>'state'='ready' and jsonb_typeof(v->'artifact')='object') or
      (old.voice_delivery->>'state'='ready' and v->>'state'='attempted' and
        (v->'artifact') is not distinct from (old.voice_delivery->'artifact'))
    ) is not true then raise exception 'voice_delivery_transition_denied' using errcode='23514'; end if;
  end if;
  -- Provenance comes from the durable job/message/conversation, never just the JSON descriptor.
  if not exists (
    select 1 from public.job_queue j
    join public.messages m on m.id=(v#>>'{voice,inboundMessageId}')::uuid
      and m.organization_id=j.organization_id and m.contact_id=j.contact_id
    join public.conversations c on c.id=m.conversation_id and c.organization_id=m.organization_id
      and c.contact_id=m.contact_id and c.channel_session_id=m.channel_session_id
    where j.id=new.job_id and j.organization_id=new.organization_id and j.contact_id=new.contact_id
      and j.kind='inbound_turn' and m.direction='inbound' and m.type='audio'
      and j.payload->>'inbound_message_id'=m.id::text and j.payload->>'conversation_id'=c.id::text
  ) then raise exception 'voice_delivery_binding_denied' using errcode='23514'; end if;
  return new;
end;
$fn$;
revoke execute on function public.fn_voice_delivery_guard() from public, anon, authenticated;
grant execute on function public.fn_voice_delivery_guard() to service_role;
drop trigger if exists trg_voice_delivery_guard on public.send_ledger;
create trigger trg_voice_delivery_guard before insert or update or delete on public.send_ledger
for each row execute function public.fn_voice_delivery_guard();
comment on column public.send_ledger.voice_delivery is
  'Server-owned voice artifact identity and monotone reserved/preparing/ready/attempted fence. Uncertain attempts require receipt reconciliation, never automatic resend.';
