// "Verify chain": re-hashes the append-only audit log server-side (GET /api/audit/verify) and shows the verdict.
import { ShieldCheck, ShieldX, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { Button } from "../ui";
import { readErrorText } from "../workspace/feedback";

export interface VerifyResult {
  intact: boolean;
  checked: number;
  problems: { audit_id: number; problem: string }[];
}

type State = { kind: "idle" } | { kind: "loading" } | { kind: "done"; result: VerifyResult; source: string } | { kind: "error"; message: string };

export default function AuditVerify() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const verify = async () => {
    setState({ kind: "loading" });
    try {
      const env = await api.get<VerifyResult>("/api/audit/verify");
      setState({ kind: "done", result: env.data, source: env.source });
    } catch (err) {
      setState({ kind: "error", message: readErrorText(err) });
    }
  };
  return (
    <div className="space-y-2">
      <Button variant="secondary" icon={<ShieldCheck size={14} aria-hidden />} loading={state.kind === "loading"} onClick={() => void verify()}>
        Verify chain
      </Button>
      <div aria-live="polite">
        {state.kind === "done" && state.result.intact && (
          <p className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-ui-sm" data-verdict="intact">
            <ShieldCheck size={15} aria-hidden className="text-success" />
            <span><b>Chain intact.</b> {state.result.checked.toLocaleString()} rows checked; every row hash matches its predecessor.</span>
          </p>
        )}
        {state.kind === "done" && !state.result.intact && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm" data-verdict="broken">
            <p className="flex items-center gap-2 font-semibold">
              <ShieldX size={15} aria-hidden className="text-destructive" />
              {state.result.problems.length === 1 ? "1 problem" : `${state.result.problems.length} problems`} found in {state.result.checked.toLocaleString()} rows checked
              {state.source === "synthetic" ? " (verification couldn't reach Lakebase)" : ""}
            </p>
            <ul className="mt-1.5 space-y-0.5 text-ui-xs">
              {state.result.problems.slice(0, 20).map((p, i) => (
                <li key={`${p.audit_id}-${i}`}><span className="font-mono">#{p.audit_id}</span> {p.problem}</li>
              ))}
              {state.result.problems.length > 20 && <li className="text-muted-foreground">+{state.result.problems.length - 20} more</li>}
            </ul>
          </div>
        )}
        {state.kind === "error" && (
          <p className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-sm" data-verdict="error">
            <TriangleAlert size={15} aria-hidden className="text-warning" /> Couldn't verify: {state.message}
          </p>
        )}
      </div>
    </div>
  );
}
