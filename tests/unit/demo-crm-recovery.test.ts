import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoCrmRecovery } from "@/lib/channels/demo-crm-recovery";
import { DEMO_WEB_CHANNEL, demoWebRequestAllowed } from "@/lib/channels/demo-web-ingress";
import { demoCrmOriginAllowed } from "@/lib/channels/demo-crm-origin";
import { withDemoStaffDelivery, assertDemoStaffDelivery, type StaffDelivery } from "@/lib/channels/demo-staff-delivery";
import { assertDemoTransport, assertDemoOutbound } from "@/lib/channels/demo-inbound-only";
import { transcribeDemoVoice } from "@/lib/channels/demo-voice";
const f = vi.hoisted(() => ({media: vi.fn(), transcribe: vi.fn(), destination: vi.fn()}));
vi.mock("@/lib/channels", () => ({getAdapter: () => ({fetchInboundMedia: f.media})}));
vi.mock("@/lib/messaging/media/transcription", () => ({apiTranscriptionProvider: () => ({transcribe: f.transcribe})}));
vi.mock("@/lib/automation/destinos-internos-autorizados", () => ({motivoDaRecusaDeDestino: f.destination}));
const org="10000000-0000-4000-8000-000000000001", conversation="20000000-0000-4000-8000-000000000001";
const binding={channelId:DEMO_WEB_CHANNEL,organizationId:org,startedAt:"2026-10-14T00:00:00Z"};
const delivery: StaffDelivery={id:"30000000-0000-4000-8000-000000000001",organization_id:org,channel_session_id:DEMO_WEB_CHANNEL,conversation_id:conversation,contact_id:"40000000-0000-4000-8000-000000000001",actor_id:"50000000-0000-4000-8000-000000000001",message_id:"60000000-0000-4000-8000-000000000001",body:"Synthetic staff reply",status:"sending"};
const worker=()=>{vi.stubEnv("ZSAI_AGENT_RUNTIME","python");vi.stubEnv("DEMO_WEB_INGRESS_ONLY","false");vi.stubEnv("DEMO_INBOUND_ONLY","true");vi.stubEnv("DEMO_CHANNEL_ID",DEMO_WEB_CHANNEL);};
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("DEMO_CRM_OPERATIONAL","true");worker();});
afterEach(()=>vi.unstubAllEnvs());
describe("explicit recovery gates",()=>{
 it("is disabled by default and rejects unbound/invalid operational mode",()=>{
  expect(demoCrmRecovery({})).toBe(false);
  for(const vars of [{DEMO_CRM_OPERATIONAL:"yes"},{DEMO_CRM_OPERATIONAL:"true"},{DEMO_CRM_OPERATIONAL:"true",DEMO_INBOUND_ONLY:"true",DEMO_CHANNEL_ID:"df10c6c2-d728-47a4-8995-240fba6d4799"}])expect(()=>demoCrmRecovery(vars)).toThrow();
 });
 it("accepts exact independently configured web and worker modes",()=>{
  expect(demoCrmRecovery({DEMO_CRM_OPERATIONAL:"true",DEMO_WEB_INGRESS_ONLY:"true",DEMO_WEB_CHANNEL_ID:DEMO_WEB_CHANNEL})).toBe(true);
  expect(demoCrmRecovery()).toBe(true);
  expect(()=>demoCrmRecovery({DEMO_CRM_OPERATIONAL:"true",DEMO_INBOUND_ONLY:"true",DEMO_CHANNEL_ID:DEMO_WEB_CHANNEL,ZSAI_AGENT_RUNTIME:"native"})).toThrow();
 });
 it("restores only curated CRM routes, while automation/actions and other pages stay denied",()=>{
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY","true");vi.stubEnv("DEMO_INBOUND_ONLY","false");vi.stubEnv("DEMO_WEB_CHANNEL_ID",DEMO_WEB_CHANNEL);
  expect(demoWebRequestAllowed(`/api/v1/conversations/${conversation}/claim`,"POST",false)).toBe(true);
  expect(demoWebRequestAllowed("/api/v1/messages","POST",false)).toBe(true);
  for(const p of ["/api/v1/cron/tick","/api/v1/ai/inbox","/api/v1/leads/export","/app/contacts"])expect(demoWebRequestAllowed(p,"GET",false)).toBe(false);
  expect(demoWebRequestAllowed(`/api/v1/conversations/${conversation}/claim`,"POST",true)).toBe(false);
  vi.stubEnv("DEMO_CRM_OPERATIONAL","false");expect(demoWebRequestAllowed("/api/v1/messages","POST",false)).toBe(false);
 });
});
describe("strict write origin",()=>{
 const req=(origin?:string,type="application/json",action=false)=>new Request("https://internal.invalid/api/v1/messages",{method:"POST",headers:{...(origin?{origin}:{}),"content-type":type,...(action?{"next-action":"synthetic"}:{})}});
 it("accepts the configured public origin independently of internal request host",()=>expect(demoCrmOriginAllowed(req("https://demo.invalid"),"https://demo.invalid")).toBe(true));
 it.each([undefined,"https://foreign.invalid","null"])("rejects missing or foreign origin %s",origin=>expect(demoCrmOriginAllowed(req(origin),"https://demo.invalid")).toBe(false));
 it("rejects invalid config, non-JSON and server actions",()=>{
  expect(demoCrmOriginAllowed(req("https://demo.invalid"),"bad")).toBe(false);
  expect(demoCrmOriginAllowed(req("https://demo.invalid","text/plain"),"https://demo.invalid")).toBe(false);
  expect(demoCrmOriginAllowed(req("https://demo.invalid","application/json",true),"https://demo.invalid")).toBe(false);
 });
});
describe("worker-only durable staff authority",()=>{
 const database=()=>({query:vi.fn().mockResolvedValue({rows:[{session_ref:"222",recipient:"+15555550001"}]})});
 it("permits only a claimed, currently authorized delivery at the exact transport",async()=>{
  const db=database();await withDemoStaffDelivery(db,binding,delivery,async()=>{
   await assertDemoOutbound(org,conversation);await assertDemoTransport({organizationId:org,sessionRef:"222",to:"15555550001",kind:"text"});
  });expect(db.query.mock.calls.every(([,params])=>params[1]===org&&params[2]===DEMO_WEB_CHANNEL)).toBe(true);
 });
 it.each(["tenant","channel","state"])("rejects wrong %s before any send",async kind=>{
  const row={...delivery,...(kind==="tenant"?{organization_id:"foreign"}:kind==="channel"?{channel_session_id:"other"}:{status:"pending"})};
  await expect(withDemoStaffDelivery(database(),binding,row,async()=>{})).rejects.toThrow();
 });
 it.each(["no-row","db-error","foreign-recipient","foreign-transport","media"])("denies %s at the final boundary",async kind=>{
  const db=database();if(kind==="no-row")db.query.mockResolvedValue({rows:[]});if(kind==="db-error")db.query.mockRejectedValue(Error("synthetic"));
  await expect(withDemoStaffDelivery(db,binding,delivery,async()=>assertDemoTransport({organizationId:org,sessionRef:kind==="foreign-transport"?"other":"222",to:kind==="foreign-recipient"?"15555559999":"15555550001",kind:kind==="media"?"audio":"text"}))).rejects.toThrow();
 });
 it("denies outbound with no claimed context and cannot authorize a web sender",async()=>{
  expect(await assertDemoStaffDelivery(org,conversation)).toBe(false);await expect(assertDemoOutbound(org,conversation)).rejects.toThrow();
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY","true");await expect(withDemoStaffDelivery(database(),binding,delivery,async()=>{})).rejects.toThrow();
 });
});
describe("bounded voice transcription",()=>{
 beforeEach(()=>{vi.stubEnv("TRANSCRIPTION_API_KEY","synthetic-test-key");vi.stubEnv("TRANSCRIPTION_BASE_URL","");f.media.mockResolvedValue({buffer:Buffer.from("synthetic"),mime:"audio/ogg"});f.transcribe.mockResolvedValue("Synthetic voice transcript");});
 it("uses trusted Meta identity and returns text for the unchanged Python V2 contract",async()=>{
  const result=await transcribeDemoVoice(org,"222",{id:"synthetic-audio"});expect(result.text).toBe("Synthetic voice transcript");
  expect(f.media).toHaveBeenCalledWith({organizationId:org,sessionRef:"222",url:"meta-media:synthetic-audio",hintMime:null});
 });
 it.each(["missing-key","bad-type","empty","oversize","failed-provider","unsafe-destination"])("fails closed on %s",async kind=>{
  if(kind==="missing-key"){vi.stubEnv("TRANSCRIPTION_API_KEY","");vi.stubEnv("OPENAI_API_KEY","");}
  if(kind==="bad-type")f.media.mockResolvedValue({buffer:Buffer.from("synthetic"),mime:"text/html"});
  if(kind==="empty")f.transcribe.mockResolvedValue("");if(kind==="oversize")f.transcribe.mockResolvedValue("x".repeat(4001));
  if(kind==="failed-provider")f.transcribe.mockRejectedValue(Error("synthetic"));
  if(kind==="unsafe-destination"){vi.stubEnv("TRANSCRIPTION_BASE_URL","http://127.0.0.1");f.destination.mockResolvedValue("denied");}
  await expect(transcribeDemoVoice(org,"222",{id:"synthetic-audio"})).rejects.toThrow();
 });
});
