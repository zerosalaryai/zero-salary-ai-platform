-- Stamp provenance at owned receipt insertion, never at job claim or historical replay.
create or replace function public.fn_demo_message_service_boundary()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare c public.conversations; d public.demandas;
begin
 if new.channel_session_id is distinct from 'c67e9f8a-8719-4481-9154-ed8a464f85bd'::uuid
   or new.direction is distinct from 'inbound' then return new; end if;
 -- Require an in-flight receipt owned by THIS transaction, not a completed receipt.
 if not exists(select 1 from public.demo_inbound_receipts r
   where r.organization_id=new.organization_id and r.channel_session_id=new.channel_session_id
     and r.message_id=new.id and r.contact_id=new.contact_id and r.conversation_id=new.conversation_id
     and r.meta_message_id=new.external_id and r.outcome='pending'
     and r.owner_txid=txid_current() and r.id::text=current_setting('zero_salary.demo_receipt',true))
   then return new; end if;
 -- Same canonical lock order as atomic ingress, before message FK locks.
 perform public.fn_service_lock(new.organization_id,new.contact_id);
 select * into c from public.conversations where id=new.conversation_id
   and organization_id=new.organization_id and contact_id=new.contact_id
   and channel_session_id=new.channel_session_id for no key update;
 if not found or c.service_revision is null or c.service_revision<1
   or c.status in ('closed','resolved','archived') then
   raise exception 'demo_inbound_denied'; end if;
 if c.current_demanda_id is not null then
   select * into d from public.demandas where id=c.current_demanda_id
     and organization_id=c.organization_id and contact_id=c.contact_id;
   if not found or d.fechada_em is not null then raise exception 'demo_inbound_denied'; end if;
 end if;
 new.service_revision:=c.service_revision;
 new.demanda_id:=d.id;
 new.demanda_revision:=d.revision;
 return new;
end; $$;
revoke all on function public.fn_demo_message_service_boundary() from public,anon,authenticated;
grant execute on function public.fn_demo_message_service_boundary() to service_role;
drop trigger if exists trg_demo_message_service_boundary on public.messages;
create trigger trg_demo_message_service_boundary before insert on public.messages
 for each row execute function public.fn_demo_message_service_boundary();
-- No backfill; fn_job_service_boundary remains authoritative and unchanged.
