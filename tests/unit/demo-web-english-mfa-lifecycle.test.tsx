// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ translate: (s: string) => s, demo: true, request: vi.fn(), enroll: vi.fn(), confirm: vi.fn() }));
vi.mock("@/lib/i18n/IdiomaProvider", () => ({ useDemoWebPresentation: () => f.demo }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => f.translate }));
vi.mock("@/lib/auth/demo-web-login", () => ({ demoWebLogin: f.request }));
vi.mock("@/app/actions/auth/enrollMfa", () => ({ enrollMfa: f.enroll }));
vi.mock("@/app/actions/auth/confirmMfaEnroll", () => ({ confirmMfaEnroll: f.confirm }));
vi.mock("@/components/auth/TOTPInput", () => ({ TOTPInput: ({onComplete}: {onComplete: (v:string)=>void}) => <button onClick={()=>onComplete("123456")}>Synthetic code</button> }));
vi.mock("@/components/auth/RecoveryCodesPanel", () => ({ RecoveryCodesPanel: () => <div>Recovery acknowledgement required</div> }));
import { MfaEnrollModal } from "@/components/auth/MfaEnrollModal";
const enrolled = { ok: true, factor_id: "12345678-1234-4123-8123-123456789abc", qr_data_url:"data:image/png;base64,", uri:"synthetic-uri",secret:"synthetic-secret" };
beforeEach(() => { vi.resetAllMocks(); f.demo = true; f.request.mockImplementation(async body => body.kind === "enroll" ? enrolled : { ok:true,recovery_codes:[] }); f.enroll.mockResolvedValue(enrolled); f.confirm.mockResolvedValue({ok:true,recovery_codes:[]}); });
afterEach(cleanup);
it.each([true,false])("preserves mandatory enrollment and confirmation (demo=%s)", async demo => {
 f.demo = demo; render(<MfaEnrollModal />); fireEvent.click(screen.getByText("Iniciar configuração"));
 fireEvent.click(await screen.findByText("Synthetic code"));
 await screen.findByText("Recovery acknowledgement required");
 if(demo) { expect(f.request).toHaveBeenCalledWith({kind:"enroll"}); expect(f.request).toHaveBeenCalledWith({kind:"confirm-enroll",code:"123456",factor_id:enrolled.factor_id}); expect(f.enroll).not.toHaveBeenCalled(); expect(f.confirm).not.toHaveBeenCalled(); }
 else { expect(f.request).not.toHaveBeenCalled(); expect(f.enroll).toHaveBeenCalledOnce(); expect(f.confirm).toHaveBeenCalledWith("123456",enrolled.factor_id); }
});
it("keeps enrollment blocked and displays a safe error on denied auth", async () => {
 f.request.mockRejectedValue(new Error("denied")); render(<MfaEnrollModal />); fireEvent.click(screen.getByText("Iniciar configuração"));
 await screen.findByText("Não foi possível iniciar a configuração."); expect(screen.queryByText("Recovery acknowledgement required")).toBeNull(); expect(f.enroll).not.toHaveBeenCalled();
});
