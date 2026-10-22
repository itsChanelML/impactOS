import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AuditEvent, GrantEvaluation, GrantOpportunity, HumanDecision, QuarantinedBlock,
} from "./types.js";

export interface StoreState {
  grants: Record<string, GrantOpportunity>;
  evaluations: Record<string, GrantEvaluation>;
  decisions: Record<string, HumanDecision>;
  processed: Record<string, true>; // `${messageId}@${parserVersion}`
  quarantine: QuarantinedBlock[];
  audit: AuditEvent[];
  /** Last human-column values synced with the Sheet, per grant; lets sync tell a human edit from a stale cell. */
  sheet_sync: Record<string, { owner?: string; decision?: string }>;
  seq: number;
}

const empty = (): StoreState => ({
  grants: {}, evaluations: {}, decisions: {}, processed: {}, quarantine: [], audit: [], sheet_sync: {}, seq: 0,
});

/** Canonical record store. In-memory by default; pass a path to persist as JSON. Swap for Firestore/Postgres adapters. */
export class Store {
  state: StoreState;
  constructor(private readonly path?: string) {
    this.state = path && existsSync(path) ? { ...empty(), ...JSON.parse(readFileSync(path, "utf8")) } : empty();
  }
  nextId(prefix: string): string {
    return `${prefix}_${String(++this.state.seq).padStart(5, "0")}`;
  }
  log(e: Omit<AuditEvent, "id">): AuditEvent {
    const ev = { id: this.nextId("evt"), ...e };
    this.state.audit.push(ev);
    return ev;
  }
  grants(): GrantOpportunity[] {
    return Object.values(this.state.grants);
  }
  latestDecision(grantId: string): HumanDecision | undefined {
    const id = this.state.grants[grantId]?.human_decision_id;
    return id ? this.state.decisions[id] : undefined;
  }
  latestEvaluation(grantId: string): GrantEvaluation | undefined {
    const id = this.state.grants[grantId]?.evaluation_id;
    return id ? this.state.evaluations[id] : undefined;
  }
  /** Grants currently being worked: status `pursue` counts against capacity. */
  activeApplications(): number {
    return this.grants().filter((g) => g.status === "pursue").length;
  }
  save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }
}
