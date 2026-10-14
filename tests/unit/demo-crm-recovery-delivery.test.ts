import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {demoStaffTick} from "@/workers/agent-worker/demo-staff";
import {assertDemoTransport} from "@/lib/channels/demo-inbound-only";
import {DEMO_WEB_CHANNEL} from "@/lib/channels/demo-web-ingress";
const f=vi.hoisted(()=>({send:vi.fn()}));
vi.mock("@/app/api/v1/messages/_handler",()=>({sendMessageHandler:f.send}));
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:()=>({})}));
const org="10000000-0000-4000-8000-000000000001",conv="20000000-0000-4000-8000-000000000001",binding={channelId:DEMO_WEB_CHANNEL,organizationId:org,startedAt:"2026-10-14T00:00:00Z"};
const row={id:"30000000-0000-4000-8000-000000000001",organization_id:org,channel_session_id:DEMO_WEB_CHANNEL,conversation_id:conv,contact_id:"40000000-0000-4000-8000-000000000001",actor_id:"50000000-0000-4000-8000-000000000001",message_id:"60000000-0000-4000-8000-000000000001",body:"Synthetic staff",status:"sending"};
function pool(){let pending=true;return{query:vi.fn(async(sql:string)=>{if(sql.includes("fn_demo_claim_staff_reply")){const rows=pending?[row]:[];pending=false;return{rows};}if(sql.includes("fn_demo_settle_staff_reply"))return{rows:[]};return{rows:[{session_ref:"222",recipient:"+15555550001"}]};})};}
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("DEMO_CRM_OPERATIONAL","true");vi.stubEnv("DEMO_INBOUND_ONLY","true");vi.stubEnv("DEMO_WEB_INGRESS_ONLY","false");vi.stubEnv("DEMO_CHANNEL_ID",DEMO_WEB_CHANNEL);vi.stubEnv("ZSAI_AGENT_RUNTIME","python");});
afterEach(()=>vi.unstubAllEnvs());
describe("one staff executor, no uncertain retries",()=>{
 it("reuses the canonical handler with the durable message ID and correct staff attribution",async()=>{
  f.send.mockImplementation(async()=>{await assertDemoTransport({organizationId:org,sessionRef:"222",to:"15555550001",kind:"text"});return{status:"sent",external_id:"synthetic-meta-id"};});
  const db=pool();await demoStaffTick(db as never,binding);await demoStaffTick(db as never,binding);
  expect(f.send).toHaveBeenCalledTimes(1);expect(f.send).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({internalMessageId:row.message_id,actor:{type:"user",id:row.actor_id}}),{conversation_id:conv,type:"text",body:row.body});
  expect(db.query).toHaveBeenCalledWith("select public.fn_demo_settle_staff_reply($1,$2,$3)",[org,row.id,"sent"]);
 });
 it("a lost transport acknowledgement is uncertain, never retried or falsely sent",async()=>{f.send.mockRejectedValue(Error("synthetic accepted response lost"));const db=pool();await expect(demoStaffTick(db as never,binding)).rejects.toThrow();await demoStaffTick(db as never,binding);expect(f.send).toHaveBeenCalledTimes(1);expect(db.query).toHaveBeenCalledWith("select public.fn_demo_settle_staff_reply($1,$2,$3)",[org,row.id,"uncertain"]);});
 it("does not claim anything outside the explicit recovery opt-in",async()=>{vi.stubEnv("DEMO_CRM_OPERATIONAL","false");const db=pool();await demoStaffTick(db as never,binding);expect(db.query).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();});
});
