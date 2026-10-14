import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {bindDemoWebToken,withDemoWebInbound,ingestDemoWebAtomic} from "@/lib/channels/demo-web-binding";
import {DEMO_WEB_CHANNEL} from "@/lib/channels/demo-web-ingress";
import type {InboundMessageEvent} from "@/lib/channels/meta/webhook";
const f=vi.hoisted(()=>({transcribe:vi.fn()}));
vi.mock("@/lib/channels/demo-voice",()=>({transcribeDemoVoice:f.transcribe}));
const org="10000000-0000-4000-8000-000000000001",message="20000000-0000-4000-8000-000000000001",conversation="30000000-0000-4000-8000-000000000001",eventId="40000000-0000-4000-8000-000000000001";
const event=()=>({externalId:"synthetic-audio",wabaId:"111",phoneNumberId:"222",from:"15555550001",sentAt:new Date(),type:"audio",text:null,profileName:"Synthetic",media:{id:"synthetic-media",url:null,mime:"audio/ogg",voice:true}} as InboundMessageEvent);
function admin(){const query={eq:vi.fn().mockReturnThis()};return {rpc:vi.fn().mockResolvedValue({data:{duplicate:false,message_id:message,conversation_id:conversation,outcome:"dispatch_recorded",dispatch_event_id:eventId}}),storage:{from:vi.fn(()=>({upload:vi.fn().mockResolvedValue({error:null})}))},from:vi.fn(()=>({update:vi.fn(()=>query)}))};}
async function run(a:ReturnType<typeof admin>,e=event()){
 const ctx=await bindDemoWebToken("synthetic-token",{query:vi.fn().mockResolvedValue({rows:[{id:DEMO_WEB_CHANNEL,organization_id:org,meta_waba_id:"111",meta_phone_number_id:"222",started_at:new Date().toISOString()}]})});
 return withDemoWebInbound(ctx,e,()=>ingestDemoWebAtomic(a as never,e,org));
}
beforeEach(()=>{vi.stubEnv("DEMO_WEB_INGRESS_ONLY","true");vi.stubEnv("DEMO_WEB_CHANNEL_ID",DEMO_WEB_CHANNEL);vi.stubEnv("DEMO_INBOUND_ONLY","false");vi.stubEnv("DEMO_CRM_OPERATIONAL","true");vi.clearAllMocks();f.transcribe.mockResolvedValue({text:"Synthetic voice transcript",buffer:Buffer.from("synthetic-audio"),mime:"audio/ogg"});});
afterEach(()=>vi.unstubAllEnvs());
describe("signed bound voice ingress to durable V2 dispatch",()=>{
 it("retains raw source identity, supplies transcript separately and persists media only after receipt acknowledgement",async()=>{
  const a=admin();expect(await run(a)).toMatchObject({status:"ingested",messageId:message,conversationId:conversation});
  const [name,args]=a.rpc.mock.calls[0]!;expect(name).toBe("fn_demo_ingest_meta_recovery");expect(args).toMatchObject({p_org:org,p_channel:DEMO_WEB_CHANNEL,p_waba:"111",p_phone:"222",p_transcript:"Synthetic voice transcript",p_opt_out:false});
  expect(JSON.parse(args.p_source)).toMatchObject({type:"audio",body:null,external_id:"synthetic-audio",media_url:"meta-media:synthetic-media"});expect(f.transcribe).toHaveBeenCalledWith(org,"222",expect.objectContaining({id:"synthetic-media"}));
 });
 it("applies spoken STOP detection before the canonical receipt RPC",async()=>{f.transcribe.mockResolvedValue({text:"STOP",buffer:Buffer.from("synthetic"),mime:"audio/ogg"});const a=admin();a.rpc.mockResolvedValue({data:{duplicate:false,message_id:message,conversation_id:conversation,outcome:"opted_out",dispatch_event_id:null}});await run(a);expect(a.rpc.mock.calls[0]?.[1].p_opt_out).toBe(true);});
 it("dispatches nothing on a failed transcription or mismatched transport binding",async()=>{f.transcribe.mockRejectedValue(Error("synthetic"));const a=admin();await expect(run(a)).rejects.toThrow();expect(a.rpc).not.toHaveBeenCalled();f.transcribe.mockClear();await expect(run(a,{...event(),phoneNumberId:"foreign"})).rejects.toThrow();expect(f.transcribe).not.toHaveBeenCalled();});
 it("does not invent success when the new migration RPC is missing",async()=>{const a=admin();a.rpc.mockResolvedValue({error:{code:"PGRST202"},data:null});await expect(run(a)).rejects.toThrow();expect(a.storage.from).not.toHaveBeenCalled();});
 it("preserves the original non-operational nontext path",async()=>{vi.stubEnv("DEMO_CRM_OPERATIONAL","false");const a=admin();a.rpc.mockResolvedValue({data:{duplicate:false,message_id:message,conversation_id:conversation,outcome:"stored_nontext",dispatch_event_id:null}});await run(a);expect(a.rpc.mock.calls[0]?.[0]).toBe("fn_demo_ingest_meta");expect(f.transcribe).not.toHaveBeenCalled();});
});
