// @vitest-environment jsdom
import {render,screen,fireEvent,waitFor,cleanup} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {IdiomaProvider} from "@/lib/i18n/IdiomaProvider";
import {InboxLayout} from "@/components/inbox/InboxLayout";
import {DEMO_WEB_CHANNEL} from "@/lib/channels/demo-web-ingress";
const f=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),patch:vi.fn(),replace:vi.fn(),push:vi.fn(),row:{} as Record<string,unknown>,messages:[] as Array<Record<string,unknown>>}));
const org="10000000-0000-4000-8000-000000000001",conversation="20000000-0000-4000-8000-000000000001",contact="30000000-0000-4000-8000-000000000001",userId="50000000-0000-4000-8000-000000000001";
const user={id:userId,idioma:"en-US",support:null,is_platform_admin:false};
vi.mock("@/hooks/auth/AuthProvider",()=>({useAuth:()=>({user,activeOrg:{orgId:org,role:"agent"}}),useUser:()=>user,useActiveOrg:()=>({orgId:org,role:"agent"}),usePermission:()=>true}));
vi.mock("@/lib/api/client",()=>({apiClient:{get:f.get,post:f.post,patch:f.patch}}));
vi.mock("next/navigation",()=>({useRouter:()=>({replace:f.replace,push:f.push}),usePathname:()=>"/app/inbox",useSearchParams:()=>new URLSearchParams("filter=all")}));
vi.mock("next/link",()=>({default:({children,href,...props}:React.PropsWithChildren<{href:string}>)=><a href={href} {...props}>{children}</a>}));
vi.mock("@/lib/supabase/browser",()=>({createClient:()=>{throw Error("Browser Supabase forbidden");},prepareRealtimeAuthentication:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({createClient:()=>{throw Error("Server Supabase forbidden");}}));
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:()=>{throw Error("Admin Supabase forbidden");}}));
function mount(){return render(<IdiomaProvider locale="pt-BR" demoPresentation={{channelId:DEMO_WEB_CHANNEL,locale:"en-US",operational:true}}><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})}><InboxLayout initialSelectedId={conversation}/></QueryClientProvider></IdiomaProvider>);}
beforeEach(()=>{
 vi.clearAllMocks();vi.stubEnv("DEMO_WEB_INGRESS_ONLY","true");vi.stubEnv("DEMO_WEB_CHANNEL_ID",DEMO_WEB_CHANNEL);vi.stubEnv("DEMO_CRM_OPERATIONAL","true");
 window.matchMedia=vi.fn().mockReturnValue({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()});
 Element.prototype.scrollIntoView=vi.fn();vi.stubGlobal("ResizeObserver",class{observe(){}unobserve(){}disconnect(){}});vi.stubGlobal("IntersectionObserver",class{observe(){}unobserve(){}disconnect(){}});
 const now=new Date().toISOString();f.row={id:conversation,organization_id:org,channel_session_id:DEMO_WEB_CHANNEL,contact_id:contact,status:"open",tags:[],assigned_to_user_id:null,assigned_to_user_name:null,assignee_kind:null,bot_silenced_until:null,last_inbound_at:now,last_message_at:now,created_at:now,unread_count_for_assignee:0,is_group:false,metadata:{},contacts:{id:contact,name:"Synthetic Recovery Lead",display_name:"Synthetic Recovery Lead",phone_number:"+15555550001",tags:[],is_blocked:false,is_anonymized:false,force_human:false},channel_sessions:{phone_number:"+15555550230",display_name:"Synthetic 0230",provider:"meta_cloud"}};
 f.messages=[{id:"60000000-0000-4000-8000-000000000001",organization_id:org,conversation_id:conversation,channel_session_id:DEMO_WEB_CHANNEL,contact_id:contact,body:"Synthetic customer text",type:"text",direction:"inbound",sent_via:"external_device",status:"delivered",sent_at:now,metadata:{}},{id:"60000000-0000-4000-8000-000000000002",organization_id:org,conversation_id:conversation,channel_session_id:DEMO_WEB_CHANNEL,contact_id:contact,body:"Synthetic AI reply",type:"text",direction:"outbound",sent_via:"ai",status:"sent",sent_at:now,metadata:{}}];
 f.get.mockImplementation(async(p:string)=>{
  if(p.startsWith("/api/v1/conversations?"))return{data:[structuredClone(f.row)],meta:{has_more:false}};
  if(p===`/api/v1/conversations/${conversation}`)return{data:structuredClone(f.row)};
  if(p.includes("/messages?"))return{data:structuredClone(f.messages),meta:{has_more:false}};
  if(p.endsWith("/notes")||p.endsWith("/passagens"))return{data:[]};
  if(p.endsWith("/crm-summary"))return{data:{checkpoint_summary:"Synthetic persisted voice checkpoint summary",leads:[{id:"40000000-0000-4000-8000-000000000001",title:"Synthetic sales opportunity",status:"open",value_cents:null,currency:"USD",updated_at:now,pipeline_id:"70000000-0000-4000-8000-000000000001",custom_fields:{},field_defs:[],funil_nome:"Synthetic sales",etapa_nome:"Qualified"}],orders:[],activities:[],demandas:[],fatos:[],historico:[]}};
  if(p==="/api/v1/channel-sessions")return{data:[{id:DEMO_WEB_CHANNEL,display_name:"Synthetic 0230",phone_number:"+15555550230",provider:"meta_cloud",status:"WORKING"}]};
  if(p==="/api/v1/pipelines/default")return{data:{pipeline:{id:"70000000-0000-4000-8000-000000000001"},stages:[]}};
  if(p==="/api/v1/team/assignable")return{data:[{user_id:"50000000-0000-4000-8000-000000000002",role:"agent",full_name:"Synthetic Colleague"}]};
  throw Error("Unsupported fixture API: "+p);
 });
 f.post.mockImplementation(async(p:string,input:Record<string,unknown>)=>{
  if(p.endsWith("/claim")){f.row={...f.row,assigned_to_user_id:userId,assigned_to_user_name:"Synthetic Staff",assignee_kind:"user",status:"claimed",bot_silenced_until:"infinity"};return{data:structuredClone(f.row)};}
  if(p==="/api/v1/messages"){const m={...f.messages[1],id:"60000000-0000-4000-8000-000000000003",body:input.body,status:"queued",sent_via:"user",sent_by_user_id:userId};f.messages.push(m);return{data:m};}
  throw Error("Unsupported fixture mutation: "+p);
 });
});
afterEach(()=>{cleanup();vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe("original operational CRM recovery",()=>{
 it("labels reassignment as Transfer and opens the real assignment dialog",async()=>{
  mount();await screen.findByText("Synthetic customer text");
  fireEvent.click(screen.getByRole("button",{name:"Transfer",exact:true}));
  await screen.findByRole("dialog");expect(await screen.findByText("Transfer Chat")).toBeTruthy();
  await waitFor(()=>expect(f.get).toHaveBeenCalledWith("/api/v1/team/assignable"));
  expect(screen.queryByRole("button",{name:"Download",exact:true})).toBeNull();
 });
 it("mounts the real thread, Composer, header and lead panel instead of a replacement viewer",async()=>{
  mount();await screen.findByText("Synthetic customer text");await screen.findByText("Synthetic AI reply");await screen.findByText(/Synthetic sales opportunity/);
  expect(document.querySelector("textarea")).toBeTruthy();expect(screen.getByText("Synthetic persisted voice checkpoint summary")).toBeTruthy();
  expect(screen.queryByRole("region",{name:"Read-only demo Inbox"})).toBeNull();
  expect(f.get.mock.calls.some(([p])=>p.includes("/crm-summary"))).toBe(true);
 });
 it("runs existing takeover and Composer hooks, queuing one idempotent staff reply",async()=>{
  mount();await screen.findByText("Synthetic customer text");
  const take=screen.getAllByRole("button").find(b=>/^(Take over|Assume|Claim)$/.test(b.textContent?.trim()??""));
  if(!take)throw Error("Original takeover control not rendered: "+screen.getAllByRole("button").map(b=>b.textContent?.trim()).join(" | "));
  fireEvent.click(take);await waitFor(()=>expect(f.post).toHaveBeenCalledWith(expect.stringContaining("/claim"),expect.anything()));
  const box=document.querySelector("textarea")!;fireEvent.change(box,{target:{value:"Synthetic staff response"}});fireEvent.keyDown(box,{key:"Enter",code:"Enter",shiftKey:false});
  await waitFor(()=>expect(f.post).toHaveBeenCalledWith("/api/v1/messages",expect.objectContaining({body:"Synthetic staff response"}),expect.objectContaining({idempotencyKey:expect.stringMatching(/^[0-9a-f-]{36}$/)})));
  expect(f.post.mock.calls.filter(([p])=>p==="/api/v1/messages")).toHaveLength(1);
 });
 it("does not mount org-wide Inbox/credential/realtime/version APIs",async()=>{
  mount();await screen.findByText("Synthetic customer text");await screen.findByText(/Synthetic sales opportunity/);
  expect(f.get.mock.calls.filter(([p])=>p.split("?")[0]==="/api/v1/contacts")).toEqual([]);
  expect(f.get.mock.calls.map(([p])=>p).filter(p=>/realtime-token|auth\/interface|ai\/inbox|counts|message-templates|system\/version|retention|draft-reply/.test(p))).toEqual([]);
 });
});
