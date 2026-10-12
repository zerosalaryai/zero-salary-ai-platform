-- Demo 0230 only. No backfill, no HTTP, no historical event adoption.
-- Rollback: disable live ingress first; retain receipts/events; revert app code.
create table if not exists public.demo_inbound_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id),
  meta_message_id text not null check (length(meta_message_id) between 1 and 512),
  message_id uuid not null unique,
  contact_id uuid references public.contacts(id),
  conversation_id uuid references public.conversations(id),
  waba_id text not null,
  phone_number_id text not null,
  sender text not null,
  sent_at timestamptz not null,
  admitted_at timestamptz not null,
  payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  opt_out boolean not null,
  owner_txid bigint not null,
  contract_version smallint not null default 1 check (contract_version=1),
  outcome text not null default 'pending' check (outcome in
    ('pending','dispatch_recorded','opted_out','blocked','human_takeover','stored_nontext')),
  dispatch_event_id uuid unique references public.event_log(id),
  completed_at timestamptz,
  constraint demo_receipt_channel check (channel_session_id='c67e9f8a-8719-4481-9154-ed8a464f85bd'),
  constraint demo_receipt_identity unique (organization_id,channel_session_id,meta_message_id),
  constraint demo_receipt_message_fk foreign key(message_id) references public.messages(id)
    deferrable initially deferred,
  constraint demo_receipt_terminal check (
    (outcome='pending' and completed_at is null and dispatch_event_id is null) or
    (outcome<>'pending' and completed_at is not null and contact_id is not null and conversation_id is not null
     and ((outcome='dispatch_recorded')=(dispatch_event_id is not null))))
);
alter table public.demo_inbound_receipts enable row level security;
revoke all on public.demo_inbound_receipts from public,anon,authenticated;
revoke all on public.demo_inbound_receipts from service_role;
-- Only the SECURITY DEFINER RPC owns writes; service_role can inspect receipts.
grant select on public.demo_inbound_receipts to service_role;

create unique index if not exists demo_dispatch_one_per_message
  on public.event_log(organization_id,entity_id)
  where event_type='ai_agent.dispatch_requested' and metadata->>'demo_receipt_version'='1';

-- A different producer cannot omit the marker and dispatch this message again.
create or replace function public.fn_demo_receipt_dispatch_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare r public.demo_inbound_receipts;
begin
  select * into r from public.demo_inbound_receipts
    where organization_id=new.organization_id and (message_id=new.entity_id
      or message_id::text=new.payload->>'inbound_message_id'
      or message_id::text=new.payload->>'message_id') for share;
  if found then
    if new.event_type='message.received' or new.entity_id is distinct from r.message_id
      or r.outcome<>'pending' or r.owner_txid<>txid_current()
      or r.id::text is distinct from current_setting('zero_salary.demo_receipt',true)
      or new.entity_kind<>'message'
      or new.metadata->>'demo_receipt_id' is distinct from r.id::text
      or new.metadata->>'demo_receipt_version' is distinct from '1'
      or new.payload->>'organization_id' is distinct from r.organization_id::text
      or new.payload->>'channel_session_id' is distinct from r.channel_session_id::text
      or new.payload->>'inbound_message_id' is distinct from r.message_id::text
      or new.payload->>'contact_id' is distinct from r.contact_id::text
      or new.payload->>'conversation_id' is distinct from r.conversation_id::text
      then raise exception 'demo_inbound_denied'; end if;
  elsif new.metadata->>'demo_receipt_version'='1' then raise exception 'demo_inbound_denied';
  end if;
  return new;
end; $$;
revoke all on function public.fn_demo_receipt_dispatch_guard() from public,anon,authenticated;
drop trigger if exists trg_demo_receipt_dispatch_guard on public.event_log;
create trigger trg_demo_receipt_dispatch_guard before insert on public.event_log for each row
when (new.event_type in ('ai_agent.dispatch_requested','message.received')) execute function public.fn_demo_receipt_dispatch_guard();

-- These predicates expose only a boolean for a fully specified identity.
-- authenticated needs EXECUTE for ordinary message trigger WHEN evaluation;
-- it has no access to receipt rows and cannot manufacture receipt bindings.
create or replace function public.fn_demo_receipt_message_bound(
  p_org uuid,p_channel uuid,p_message uuid,p_contact uuid,p_conversation uuid,p_external text,p_direction text
) returns boolean language sql stable security definer set search_path=pg_catalog as $$
  select (auth.uid() is null or public.fn_role_at_least(p_org,'viewer'))
    and p_direction='inbound' and p_channel='c67e9f8a-8719-4481-9154-ed8a464f85bd' and exists (
    select 1 from public.demo_inbound_receipts r
    where r.organization_id=p_org and r.channel_session_id=p_channel and r.message_id=p_message
      and r.contact_id=p_contact and r.conversation_id=p_conversation and r.meta_message_id=p_external
      and (r.outcome<>'pending' or (r.owner_txid=txid_current()
        and r.id::text=current_setting('zero_salary.demo_receipt',true))))
$$;
revoke all on function public.fn_demo_receipt_message_bound(uuid,uuid,uuid,uuid,uuid,text,text) from public,anon;
grant execute on function public.fn_demo_receipt_message_bound(uuid,uuid,uuid,uuid,uuid,text,text) to authenticated,service_role;

-- Routing suppression applies only while this RPC creates its bound conversation.
create or replace function public.fn_demo_receipt_conversation_bound(p_org uuid,p_channel uuid,p_contact uuid)
returns boolean language sql stable security definer set search_path=pg_catalog as $$
  select p_channel='c67e9f8a-8719-4481-9154-ed8a464f85bd' and exists (
    select 1 from public.demo_inbound_receipts r where r.organization_id=p_org
      and r.channel_session_id=p_channel and r.contact_id=p_contact and r.outcome='pending'
      and r.owner_txid=txid_current() and r.id::text=current_setting('zero_salary.demo_receipt',true))
$$;
revoke all on function public.fn_demo_receipt_conversation_bound(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_demo_receipt_conversation_bound(uuid,uuid,uuid) to service_role;

-- Keep original trigger functions; narrow their firing conditions instead.
drop trigger if exists trg_messages_emit_event on public.messages;
create trigger trg_messages_emit_event after insert on public.messages for each row
when (not public.fn_demo_receipt_message_bound(new.organization_id,new.channel_session_id,new.id,
  new.contact_id,new.conversation_id,new.external_id,new.direction))
execute function public.fn_emit_message_event();
drop trigger if exists trg_demanda_abre_no_inbound on public.messages;
create trigger trg_demanda_abre_no_inbound after insert on public.messages for each row
when (not public.fn_demo_receipt_message_bound(new.organization_id,new.channel_session_id,new.id,
  new.contact_id,new.conversation_id,new.external_id,new.direction))
execute function public.fn_demanda_abre_no_inbound();
drop trigger if exists trg_appointment_inbound on public.messages;
create trigger trg_appointment_inbound after update of service_revision on public.messages for each row
when (not public.fn_demo_receipt_message_bound(new.organization_id,new.channel_session_id,new.id,
  new.contact_id,new.conversation_id,new.external_id,new.direction))
execute function public.fn_appointment_inbound();

create or replace function public.fn_emit_conversation_routing() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if public.fn_demo_receipt_conversation_bound(new.organization_id,new.channel_session_id,new.contact_id)
    then return null; end if;
  perform public.fn_request_channel_routing(new.organization_id,new.id);
  return null;
end; $$;
revoke all on function public.fn_emit_conversation_routing() from public,anon,authenticated;

create or replace function public.fn_demo_ingest_meta(
  p_token text,p_org uuid,p_channel uuid,p_waba text,p_phone text,p_admitted_at timestamptz,
  p_source text,p_fingerprint text,p_opt_out boolean
) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  s public.channel_sessions;
  r public.demo_inbound_receipts;
  c public.contacts;
  v public.conversations;
  e jsonb;
  contact uuid;
  conversation uuid;
  message uuid := gen_random_uuid();
  event uuid;
  sender text;
  canonical text;
  alternative text;
  sent timestamptz;
  candidates integer;
  duplicate boolean := false;
  result text;
  previous_context text := current_setting('zero_salary.demo_receipt',true);
begin
  if auth.uid() is not null or p_channel is distinct from 'c67e9f8a-8719-4481-9154-ed8a464f85bd'::uuid
    or p_opt_out is null or p_source is null or length(p_source)>131072
    or p_fingerprint is null or p_fingerprint<>encode(extensions.digest(convert_to(p_source,'UTF8'),'sha256'),'hex')
    then raise exception 'demo_inbound_denied'; end if;
  if not public.fn_support_write_allowed(p_org) then raise exception 'demo_inbound_denied'; end if;
  e:=p_source::jsonb;
  sender:=e->>'from'; sent:=(e->>'sent_at')::timestamptz;
  if coalesce(sender,'') !~ '^[1-9][0-9]{7,14}$' or coalesce(e->>'external_id','')=''
    or e->>'waba_id' is distinct from p_waba or e->>'phone_number_id' is distinct from p_phone
    or coalesce(e->>'type','') not in ('text','image','audio','video','document','sticker','contact')
    or sent is null or not isfinite(sent)
    or p_admitted_at is null or not isfinite(p_admitted_at)
    or p_admitted_at>clock_timestamp() or p_admitted_at<clock_timestamp()-interval '5 minutes'
    then raise exception 'demo_inbound_denied'; end if;
  select * into s from public.channel_sessions cs where cs.id=p_channel and cs.organization_id=p_org
    and cs.webhook_path_token=p_token and cs.provider='meta_cloud' and cs.archived_at is null
    and cs.metadata->>'ai_gate'='open' and cs.meta_waba_id=p_waba and cs.meta_phone_number_id=p_phone
    and p_waba ~ '^[0-9]+$' and p_phone ~ '^[0-9]+$'
    and cs.phone_number ~ '^\+?[1-9][0-9 ()-]{7,20}$'
    and right(regexp_replace(cs.phone_number,'[^0-9]','','g'),4)='0230'
    and not exists(select 1 from public.channel_sessions other where other.id<>cs.id and other.archived_at is null
      and (other.webhook_path_token=cs.webhook_path_token or
        (other.provider='meta_cloud' and other.meta_phone_number_id=cs.meta_phone_number_id)))
    for share;
  if not found then raise exception 'demo_inbound_denied'; end if;

  -- Unique reservation waits for concurrent commit/rollback before inspecting it.
  insert into public.demo_inbound_receipts(organization_id,channel_session_id,meta_message_id,message_id,
    waba_id,phone_number_id,sender,sent_at,admitted_at,payload_fingerprint,opt_out,owner_txid)
  values(p_org,p_channel,e->>'external_id',message,p_waba,p_phone,sender,sent,p_admitted_at,p_fingerprint,p_opt_out,txid_current())
  on conflict(organization_id,channel_session_id,meta_message_id) do nothing;
  duplicate:=not found;
  select * into strict r from public.demo_inbound_receipts where organization_id=p_org
    and channel_session_id=p_channel and meta_message_id=e->>'external_id' for update;
  if r.payload_fingerprint<>p_fingerprint or r.waba_id<>p_waba or r.phone_number_id<>p_phone
    or r.sender<>sender or r.sent_at<>sent or r.opt_out<>p_opt_out then raise exception 'demo_inbound_denied'; end if;
  if duplicate then
    if r.outcome='pending' or not exists(select 1 from public.messages m
      join public.contacts ct on ct.id=m.contact_id and ct.organization_id=m.organization_id
      join public.conversations cv on cv.id=m.conversation_id and cv.organization_id=m.organization_id
        and cv.contact_id=ct.id and cv.channel_session_id=m.channel_session_id
      where m.id=r.message_id and m.organization_id=p_org and m.channel_session_id=p_channel
        and m.contact_id=r.contact_id and m.conversation_id=r.conversation_id
        and m.direction='inbound' and m.external_id=r.meta_message_id and m.sent_at=r.sent_at
        and m.created_at>=r.admitted_at and m.type=e->>'type'
        and m.body is not distinct from e->>'body' and m.media_url is not distinct from e->>'media_url')
      then raise exception 'demo_inbound_denied'; end if;
    if r.outcome='dispatch_recorded' and not exists(select 1 from public.event_log ev
      where ev.id=r.dispatch_event_id and ev.organization_id=p_org and ev.entity_id=r.message_id
        and ev.event_type='ai_agent.dispatch_requested' and ev.metadata->>'demo_receipt_id'=r.id::text
        and ev.payload->>'channel_session_id'=p_channel::text
        and ev.payload->>'inbound_message_id'=r.message_id::text
        and ev.payload->>'contact_id'=r.contact_id::text and ev.payload->>'conversation_id'=r.conversation_id::text)
      then raise exception 'demo_inbound_denied'; end if;
    return jsonb_build_object('duplicate',true,'message_id',r.message_id,'conversation_id',r.conversation_id,
      'outcome',r.outcome,'dispatch_event_id',r.dispatch_event_id);
  end if;
  -- A fresh request may not adopt legacy rows or historical provider timestamps.
  if sent<p_admitted_at-interval '5 minutes' or sent>clock_timestamp()+interval '1 minute'
    or exists(select 1 from public.messages where organization_id=p_org and external_id=e->>'external_id')
    then raise exception 'demo_inbound_denied'; end if;
  perform set_config('zero_salary.demo_receipt',r.id::text,true);
  canonical:='+'||sender;
  if sender ~ '^55[1-9][0-9][6-9][0-9]{7}$' then
    alternative:=canonical; canonical:='+55'||substring(sender from 3 for 2)||'9'||substring(sender from 5);
  elsif sender ~ '^55[1-9][0-9]9[6-9][0-9]{7}$' then
    alternative:='+55'||substring(sender from 3 for 2)||substring(sender from 6);
  end if;
  -- Identity mutex first, then canonical service mutex, conversation, contact.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text||':'||canonical,342));
  select count(*), (array_agg(id))[1] into candidates,contact from public.contacts
    where organization_id=p_org and is_merged_into is null and phone_number in (canonical,alternative);
  if candidates>1 then raise exception 'demo_inbound_denied'; end if;
  if contact is null then
    -- Insert-only form of fn_upsert_wa_contact's creation contract (migration 0198).
    -- Its upsert can UPDATE a competing contact before the service mutex, and
    -- its exception subtransaction gives fresh rows a different xmin from txid_current().
    -- RETURNING proves our INSERT created the row; conflict never adopts or mutates it.
    insert into public.contacts(organization_id,phone_number,source,consent,tags,source_metadata,display_name)
    values(p_org,canonical,'whatsapp','{}'::jsonb,'{}'::text[],
      jsonb_build_object('waha_chat_id',sender,'notify_name',nullif(e->>'profile_name','')),
      nullif(e->>'profile_name',''))
    on conflict do nothing returning id into contact;
    if contact is null or not exists(select 1 from public.contacts where id=contact
      and organization_id=p_org and phone_number=canonical and is_merged_into is null)
      then raise exception 'demo_inbound_denied'; end if;
  end if;
  perform public.fn_service_lock(p_org,contact);
  update public.demo_inbound_receipts set contact_id=contact where id=r.id;
  select count(*) into candidates from public.conversations where organization_id=p_org
    and contact_id=contact and channel_session_id=p_channel and is_group is false;
  if candidates>1 then raise exception 'demo_inbound_denied'; end if;
  select * into v from public.conversations where organization_id=p_org and contact_id=contact
    and channel_session_id=p_channel and is_group is false for no key update;
  if not found then
    conversation:=public.fn_upsert_wa_conversation(p_org,contact,p_channel);
    select * into strict v from public.conversations where id=conversation and organization_id=p_org
      and channel_session_id=p_channel and contact_id=contact for no key update;
  end if;
  conversation:=v.id;
  select * into strict c from public.contacts where id=contact and organization_id=p_org for no key update;
  if c.is_merged_into is not null or c.is_anonymized is distinct from false or v.is_group is distinct from false
    or sent<=v.service_closed_at or v.status in ('closed','resolved','archived')
    then raise exception 'demo_inbound_denied'; end if;
  update public.demo_inbound_receipts set conversation_id=conversation where id=r.id;
  insert into public.messages(id,organization_id,channel_session_id,contact_id,conversation_id,
    direction,status,type,body,external_id,sent_at,media_url,media_mime,metadata)
  values(message,p_org,p_channel,contact,conversation,'inbound','delivered',e->>'type',e->>'body',
    e->>'external_id',sent,e->>'media_url',e->>'media_mime',coalesce(e->'metadata','{}'::jsonb));
  perform public.fn_mark_conversation_message(conversation,'inbound',left(e->>'body',120),sent);
  if p_opt_out then
    update public.contacts set is_blocked=true,blocked_reason='stop_keyword',blocked_at=clock_timestamp()
      where id=contact and organization_id=p_org;
    if not found then raise exception 'demo_inbound_denied'; end if;
    result:='opted_out';
  elsif c.is_blocked is true then result:='blocked';
  elsif c.is_blocked is null or c.force_human is null then raise exception 'demo_inbound_denied';
  elsif c.force_human or v.assignee_kind='human' or v.assigned_to_user_id is not null
    or v.bot_silenced_until>clock_timestamp() or exists(select 1 from public.conversations h
      where h.organization_id=p_org and h.contact_id=contact and h.bot_silenced_until>clock_timestamp())
    then result:='human_takeover';
  elsif v.assignee_kind is not null and v.assignee_kind<>'ai' then raise exception 'demo_inbound_denied';
  elsif e->>'type'<>'text' then result:='stored_nontext';
  elsif nullif(btrim(e->>'body'),'') is null then raise exception 'demo_inbound_denied';
  else
    event:=public.emit_event('ai_agent.dispatch_requested','message',message,
      jsonb_build_object('organization_id',p_org,'channel_session_id',p_channel,'contact_id',contact,
        'conversation_id',conversation,'inbound_message_id',message),
      jsonb_build_object('source','meta_webhook','demo_web_ingress',true,'demo_receipt_version','1','demo_receipt_id',r.id),p_org);
    if event is null then raise exception 'demo_inbound_denied'; end if;
    result:='dispatch_recorded';
  end if;
  update public.demo_inbound_receipts set outcome=result,dispatch_event_id=event,completed_at=clock_timestamp() where id=r.id;
  perform set_config('zero_salary.demo_receipt',coalesce(previous_context,''),true);
  return jsonb_build_object('duplicate',false,'message_id',message,'conversation_id',conversation,
    'outcome',result,'dispatch_event_id',event);
end; $$;
revoke all on function public.fn_demo_ingest_meta(text,uuid,uuid,text,text,timestamptz,text,text,boolean) from public,anon,authenticated;
grant execute on function public.fn_demo_ingest_meta(text,uuid,uuid,text,text,timestamptz,text,text,boolean) to service_role;
