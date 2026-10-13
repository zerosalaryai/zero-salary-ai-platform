import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { demoWebLogin } from "@/lib/auth/demo-web-login";
const assign = vi.fn();
const originalWindow = globalThis.window;
beforeEach(() => { vi.mocked(fetch).mockReset(); assign.mockReset(); vi.stubGlobal("window", { location: { assign } }); });
afterEach(() => vi.stubGlobal("window", originalWindow));
function reply(body: unknown, status = 200) { vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body), {status,headers:{"content-type":"application/json"}})); }
it("uses only the same-origin route and explicit cookie credentials", async () => {
 reply({data:{refreshed:true}}); expect(await demoWebLogin({kind:"refresh"})).toEqual({refreshed:true});
 expect(fetch).toHaveBeenCalledWith("/api/demo-web-auth",expect.objectContaining({method:"POST",credentials:"same-origin",cache:"no-store",body:JSON.stringify({kind:"refresh"})})); expect(assign).not.toHaveBeenCalled();
});
it("successful logout navigates to login", async () => {
 reply({data:{redirect:"/login"}}); expect(await demoWebLogin({kind:"logout"})).toBeUndefined(); expect(assign).toHaveBeenCalledWith("/login");
});
it.each([401,403,503])("rejects failed lifecycle HTTP response %s without navigation", async status => {
 reply({error:{code:"denied"}},status); await expect(demoWebLogin({kind:"logout"})).rejects.toThrow("demo authentication denied"); expect(assign).not.toHaveBeenCalled();
});
it.each([null,{}, {data:{}},{error:{code:"denied"},data:{refreshed:true}},{data:{redirect:"https://foreign.invalid"}}])("does not mistake malformed refresh success for rotation", async body => {
 reply(body); await expect(demoWebLogin({kind:"refresh"})).rejects.toThrow(); expect(assign).not.toHaveBeenCalled();
});
it.each([{data:{}},{data:{refreshed:true}},{data:{redirect:"/app"}}])("does not mistake malformed logout success for revocation", async body => {
 reply(body); await expect(demoWebLogin({kind:"logout"})).rejects.toThrow(); expect(assign).not.toHaveBeenCalled();
});
it("preserves login/TOTP action error results", async () => {
 reply({data:{ok:false,error:"mfa_invalid"}}); expect(await demoWebLogin({kind:"totp",code:"123456"})).toEqual({ok:false,error:"mfa_invalid"});
});
