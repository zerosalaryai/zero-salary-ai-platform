-- Additive recovery. 0342 remains unchanged. No backfill and no transport HTTP.
-- Rollback: disable DEMO_CRM_OPERATIONAL; preserve receipts/outbox for reconciliation.
create or replace function public.fn_demo_ingest_meta_recovery(
 p_token text,p_org uuid,p_channel uuid,p_waba text,p_phone text,p_admitted_at timestamptz,
 p_source text,p_fingerprint text,p_opt_out boolean,p_transcript text
) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb; r public.demo_inbound_receipts; event uuid;
 previous_context text:=current_setting('zero_salary.demo_receipt',true);
begin
 if p_channel<>'c67e9f8a-8719-4481-9154-ed8a464f85bd'::uuid
   or ((p_source::jsonb)->>'type'='audio' and (nullif(btrim(p_transcript),'') is null
   or length(p_transcript)>4000 or p_transcript='[mídia não lida]'))
   or ((p_source::jsonb)->>'type'<>'audio' and p_transcript is not null)
   then raise exception 'demo_voice_denied'; end if;
 -- Canonical RPC validates raw immutable source, tenant/transport, freshness,
 -- strict opt-out, blocked state and human ownership before any dispatch.
 result:=public.fn_demo_ingest_meta(p_token,p_org,p_channel,p_waba,p_phone,p_admitted_at,
   p_source,p_fingerprint,p_opt_out);
 select * into strict r from public.demo_inbound_receipts where organization_id=p_org
   and channel_session_id=p_channel and message_id=(result->>'message_id')::uuid for update;
 if exists(select 1 from public.conversations other where other.organization_id=p_org
   and other.contact_id=r.contact_id and other.channel_session_id<>p_channel)
   then raise exception 'demo_shared_contact_denied'; end if;
 if (result->>'duplicate')::boolean or result->>'outcome'<>'stored_nontext'
   or (p_source::jsonb)->>'type'<>'audio' then return result; end if;
 if r.owner_txid<>txid_current() or r.payload_fingerprint<>p_fingerprint or r.opt_out
   or r.outcome<>'stored_nontext' or r.dispatch_event_id is not null
   then raise exception 'demo_voice_denied'; end if;
 -- Only this fresh receipt's owning transaction may add its voice derivative.
 update public.messages set media_derived_text=p_transcript,media_derived_status='ready'
   where id=r.message_id and organization_id=p_org and channel_session_id=p_channel
     and conversation_id=r.conversation_id and contact_id=r.contact_id and type='audio';
 if not found then raise exception 'demo_voice_denied'; end if;
 update public.demo_inbound_receipts set outcome='pending',completed_at=null where id=r.id;
 perform set_config('zero_salary.demo_receipt',r.id::text,true);
 event:=public.emit_event('ai_agent.dispatch_requested','message',r.message_id,
   jsonb_build_object('organization_id',p_org,'channel_session_id',p_channel,'contact_id',r.contact_id,
     'conversation_id',r.conversation_id,'inbound_message_id',r.message_id),
   jsonb_build_object('source','meta_webhook','demo_web_ingress',true,'demo_receipt_version','1',
     'demo_receipt_id',r.id,'demo_voice',true),p_org);
 if event is null then raise exception 'demo_voice_denied'; end if;
 update public.demo_inbound_receipts set outcome='dispatch_recorded',dispatch_event_id=event,
   completed_at=clock_timestamp() where id=r.id;
 perform set_config('zero_salary.demo_receipt',coalesce(previous_context,''),true);
 return result||jsonb_build_object('outcome','dispatch_recorded','dispatch_event_id',event);
end; $$;
revoke all on function public.fn_demo_ingest_meta_recovery(text,uuid,uuid,text,text,timestamptz,text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.fn_demo_ingest_meta_recovery(text,uuid,uuid,text,text,timestamptz,text,text,boolean,text) to service_role;

create table if not exists public.demo_staff_deliveries (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 channel_session_id uuid not null references public.channel_sessions(id)
   check(channel_session_id='c67e9f8a-8719-4481-9154-ed8a464f85bd'),
 conversation_id uuid not null references public.conversations(id), contact_id uuid not null references public.contacts(id),
 actor_id uuid not null references auth.users(id), message_id uuid not null unique references public.messages(id),
 idempotency_key uuid not null, body text not null check(length(btrim(body)) between 1 and 4000),
 status text not null default 'pending' check(status in('pending','sending','sent','failed','uncertain')),
 created_at timestamptz not null default clock_timestamp(), attempted_at timestamptz,
 unique(organization_id,idempotency_key)
);
alter table public.demo_staff_deliveries enable row level security;
revoke all on public.demo_staff_deliveries from public,anon,authenticated,service_role;
grant select on public.demo_staff_deliveries to service_role;

create or replace function public.fn_demo_queue_staff_reply(p_org uuid,p_conversation uuid,p_key uuid,p_body text)
 returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v public.conversations; c public.contacts; s public.channel_sessions;
 existing public.demo_staff_deliveries; message uuid:=gen_random_uuid(); actor uuid:=auth.uid(); initial_contact uuid;
begin
 if actor is null or p_key is null or coalesce(public.fn_member_role_in_org(actor,p_org),'') not in('agent','manager','admin') or not public.fn_session_mfa_proven() or not public.fn_role_at_least(p_org,'agent')
   or not public.fn_support_write_allowed(p_org) or nullif(btrim(p_body),'') is null or length(p_body)>4000
   then raise exception 'demo_staff_denied'; end if;
 -- Serializes identical browser retries before message insertion.
 perform pg_advisory_xact_lock(hashtextextended(p_org::text||':'||p_key::text,343));
 select * into existing from public.demo_staff_deliveries where organization_id=p_org and idempotency_key=p_key;
 if found then
   if existing.actor_id<>actor or existing.conversation_id<>p_conversation or existing.body<>p_body
     then raise exception 'demo_staff_identity_conflict'; end if;
   return (select to_jsonb(m) from public.messages m where m.id=existing.message_id and m.organization_id=p_org);
 end if;
 -- Match canonical service lock -> conversation -> contact ordering.
 select contact_id into strict initial_contact from public.conversations where organization_id=p_org and id=p_conversation;
 perform public.fn_service_lock(p_org,initial_contact);
 select * into strict v from public.conversations where organization_id=p_org and id=p_conversation for no key update;
 if v.contact_id is distinct from initial_contact then raise exception 'demo_staff_denied'; end if;
 if exists(select 1 from public.demo_staff_deliveries where organization_id=p_org
   and conversation_id=p_conversation and actor_id=actor and body=p_body and status in('pending','sending','uncertain'))
   then raise exception 'demo_staff_reconciliation_required'; end if;
 select * into strict s from public.channel_sessions where organization_id=p_org and id=v.channel_session_id for share;
 select * into strict c from public.contacts where organization_id=p_org and id=v.contact_id for no key update;
 if s.id<>'c67e9f8a-8719-4481-9154-ed8a464f85bd'::uuid or s.provider<>'meta_cloud' or s.archived_at is not null
   or s.metadata->>'ai_gate' is distinct from 'open' or s.meta_phone_number_id is null
   or right(regexp_replace(s.phone_number,'[^0-9]','','g'),4) is distinct from '0230'
   or exists(select 1 from public.conversations other where other.organization_id=p_org
     and other.contact_id=c.id and other.channel_session_id<>s.id)
   or c.is_blocked is distinct from false or c.is_anonymized is distinct from false or c.is_merged_into is not null
   or v.is_group is distinct from false or v.assigned_to_user_id is distinct from actor
   or v.status in('closed','resolved','archived') or v.last_inbound_at is null
   or v.last_inbound_at<clock_timestamp()-interval '24 hours'
   then raise exception 'demo_staff_denied'; end if;
 insert into public.messages(id,organization_id,channel_session_id,conversation_id,contact_id,
   direction,type,body,status,sent_via,sent_by_user_id,sent_at,metadata)
 values(message,p_org,s.id,v.id,c.id,'outbound','text',p_body,'queued','user',actor,clock_timestamp(),
   jsonb_build_object('demo_staff_delivery',true,'demo_staff_delivery_state','pending'));
 insert into public.demo_staff_deliveries(organization_id,channel_session_id,conversation_id,contact_id,actor_id,message_id,idempotency_key,body)
 values(p_org,s.id,v.id,c.id,actor,message,p_key,p_body);
 return (select to_jsonb(m) from public.messages m where m.id=message and m.organization_id=p_org);
end; $$;
revoke all on function public.fn_demo_queue_staff_reply(uuid,uuid,uuid,text) from public,anon;
grant execute on function public.fn_demo_queue_staff_reply(uuid,uuid,uuid,text) to authenticated;

-- At most one transport attempt. 'sending' is intentionally NEVER reaped/retried:
-- a crashed or timed-out HTTP attempt needs reconciliation, not another send.
create or replace function public.fn_demo_claim_staff_reply(p_org uuid,p_since timestamptz)
 returns setof public.demo_staff_deliveries language plpgsql security definer set search_path=pg_catalog as $$
begin
 if p_since is null or p_since>clock_timestamp() then raise exception 'demo_staff_denied'; end if;
 return query update public.demo_staff_deliveries d set status='sending',attempted_at=clock_timestamp()
 where d.id=(select x.id from public.demo_staff_deliveries x
   join public.channel_sessions s on s.id=x.channel_session_id and s.organization_id=x.organization_id
   where x.organization_id=p_org and x.channel_session_id='c67e9f8a-8719-4481-9154-ed8a464f85bd'
     and s.provider='meta_cloud' and s.archived_at is null and s.metadata->>'ai_gate'='open'
     and x.status='pending' and x.created_at>=p_since order by x.created_at limit 1 for update of x skip locked)
 returning d.*;
end; $$;
revoke all on function public.fn_demo_claim_staff_reply(uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_demo_claim_staff_reply(uuid,timestamptz) to service_role;

create or replace function public.fn_demo_settle_staff_reply(p_org uuid,p_id uuid,p_status text)
 returns void language plpgsql security definer set search_path=pg_catalog as $$
declare message uuid;
begin
 if p_status not in('sent','failed','uncertain') then raise exception 'demo_staff_denied'; end if;
 update public.demo_staff_deliveries set status=p_status where id=p_id and organization_id=p_org
   and channel_session_id='c67e9f8a-8719-4481-9154-ed8a464f85bd' and status='sending' returning message_id into message;
 if found then update public.messages set metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('demo_staff_delivery_state',p_status)
   where organization_id=p_org and id=message and direction='outbound'; end if;
end; $$;
revoke all on function public.fn_demo_settle_staff_reply(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_demo_settle_staff_reply(uuid,uuid,text) to service_role;

-- Scope checks see all channels in this tenant, including rows hidden by RLS.
-- The existing per-user conversation visibility and MFA checks still apply.
create or replace function public.fn_demo_crm_scope(p_org uuid,p_conversation uuid,p_contact uuid,p_lead uuid)
 returns boolean language plpgsql stable security definer set search_path=pg_catalog as $$
declare contact uuid; cv public.conversations;
begin
 if auth.uid() is null or coalesce(public.fn_member_role_in_org(auth.uid(),p_org),'') not in('viewer','agent','manager','admin') or not public.fn_session_mfa_proven() or not public.fn_role_at_least(p_org,'viewer')
   or public.fn_support_context() is not null
   or ((p_conversation is not null)::int+(p_contact is not null)::int+(p_lead is not null)::int)<>1 then return false; end if;
 if p_lead is not null then
   select contact_id into contact from public.crm_leads where id=p_lead and organization_id=p_org;
 elsif p_contact is not null then contact:=p_contact;
 else select contact_id into contact from public.conversations where id=p_conversation and organization_id=p_org; end if;
 if contact is null or not exists(select 1 from public.contacts where id=contact and organization_id=p_org)
   or exists(select 1 from public.conversations where organization_id=p_org and contact_id=contact
     and channel_session_id<>'c67e9f8a-8719-4481-9154-ed8a464f85bd') then return false; end if;
 select * into cv from public.conversations where organization_id=p_org and contact_id=contact
   and channel_session_id='c67e9f8a-8719-4481-9154-ed8a464f85bd' and is_group is false
   and (p_conversation is null or id=p_conversation);
 if not found or public.fn_can_view_conversation(p_org,cv.assigned_to_user_id) is not true then return false; end if;
 return exists(select 1 from public.channel_sessions s where s.id=cv.channel_session_id and s.organization_id=p_org
   and s.provider='meta_cloud' and s.archived_at is null and s.metadata->>'ai_gate'='open'
   and right(regexp_replace(s.phone_number,'[^0-9]','','g'),4)='0230');
end; $$;
revoke all on function public.fn_demo_crm_scope(uuid,uuid,uuid,uuid) from public,anon;
grant execute on function public.fn_demo_crm_scope(uuid,uuid,uuid,uuid) to authenticated;

create or replace function public.fn_demo_crm_checkpoint_summary(p_org uuid,p_contact uuid)
 returns text language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if not public.fn_demo_crm_scope(p_org,null,p_contact,null) then raise exception 'demo_crm_scope_denied'; end if;
 return (select cp.rolling_summary from public.lead_checkpoints cp
   join public.job_queue j on j.id=cp.job_id and j.organization_id=cp.organization_id and j.contact_id=cp.contact_id
   join public.conversations cv on cv.id::text=j.payload->>'conversation_id' and cv.organization_id=j.organization_id
     and cv.contact_id=cp.contact_id and cv.channel_session_id='c67e9f8a-8719-4481-9154-ed8a464f85bd'
   where cp.organization_id=p_org and cp.contact_id=p_contact and j.kind='inbound_turn'
     and j.payload->>'channel_session_id'='c67e9f8a-8719-4481-9154-ed8a464f85bd'
   order by cp.seq desc limit 1);
end; $$;
revoke all on function public.fn_demo_crm_checkpoint_summary(uuid,uuid) from public,anon;
grant execute on function public.fn_demo_crm_checkpoint_summary(uuid,uuid) to authenticated;
