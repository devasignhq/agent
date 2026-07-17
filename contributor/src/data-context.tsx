// Shared bounty data: one GET /api/contributor/bounties drives the dashboard,
// the bounties page, the wallet stats, and the sidebar's recent list, so pages
// never fetch the same list twice. reload() after any mutation.
import React from "react";
import { api } from "./api";
import type { ContributorBounty, ContributorSummary } from "./api";
import { useAuth } from "./auth-context";

type BountiesState = {
  bounties: ContributorBounty[];
  summary: ContributorSummary;
  explorerBase: string;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

const EMPTY_SUMMARY: ContributorSummary = {
  active: 0,
  applied: 0,
  completed: 0,
  inEscrowUsdc: 0,
  lifetimeEarnedUsdc: 0,
};

const Ctx = React.createContext<BountiesState | null>(null);

export function BountiesProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const [bounties, setBounties] = React.useState<ContributorBounty[]>([]);
  const [summary, setSummary] = React.useState<ContributorSummary>(EMPTY_SUMMARY);
  const [explorerBase, setExplorerBase] = React.useState("https://stellar.expert/explorer/testnet");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    if (auth.status !== "signed_in") return;
    try {
      const data = await api.contributorBounties();
      setBounties(data.bounties);
      setSummary(data.summary);
      if (data.explorerBase) setExplorerBase(data.explorerBase);
      setError(null);
    } catch (err: any) {
      console.warn("[bounties] load failed:", err);
      setError(String(err?.message || "load_failed"));
    } finally {
      setLoading(false);
    }
  }, [auth.status]);

  React.useEffect(() => {
    if (auth.status === "signed_in") {
      setLoading(true);
      void reload();
    } else if (auth.status !== "loading") {
      setBounties([]);
      setSummary(EMPTY_SUMMARY);
      setLoading(false);
    }
  }, [auth.status, reload]);

  const value: BountiesState = { bounties, summary, explorerBase, loading, error, reload };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBounties(): BountiesState {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useBounties must be used inside <BountiesProvider>");
  return v;
}
