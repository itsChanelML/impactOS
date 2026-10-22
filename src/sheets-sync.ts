import { recordDecision } from "./pipeline.js";
import {
  DECISION_VALUES, HUMAN, HUMAN_HEADERS, SHEET_COLUMNS, SYNC_STATUS_HEADER, SYSTEM_COLUMNS, contextFor, humanValues,
} from "./sheet.js";
import type { Store } from "./store.js";
import type { DecisionKind } from "./types.js";

/** Minimal surface the sync needs, so it can run against Google Sheets, a test double, or another backend. */
export interface SheetsClient {
  /** All values on the tab, row-major, starting at A1. Rows may be shorter than the header. */
  getValues(tab: string): Promise<string[][]>;
  /** Write cells as literal text. Implementations MUST NOT interpret values as formulas. */
  writeCells(tab: string, cells: { row: number; col: number; value: string }[]): Promise<void>;
}

export interface SyncResult {
  appended: number;
  cellsWritten: number;
  decisionsApplied: number;
  ownersApplied: number;
  rejected: { recordId: string; reason: string }[];
}

const norm = (s: string | undefined) => (s ?? "").trim();
const normDecision = (s: string) => s.trim().toUpperCase().replace(/[\s-]+/g, "_");

/**
 * Two-way sync. Order matters:
 *  1. PULL human columns (owner, decision) into the store, through the same rules as the CLI.
 *  2. PUSH system columns to the Sheet, matched by Record ID and header name.
 * Human columns are only overwritten when the cell has not been edited since the last sync.
 * Sheet edits can never bypass the decision rules: overrides need a reason, actors are required.
 */
export async function syncSheet(store: Store, client: SheetsClient, tab: string, now = new Date()): Promise<SyncResult> {
  const result: SyncResult = { appended: 0, cellsWritten: 0, decisionsApplied: 0, ownersApplied: 0, rejected: [] };
  const values = await client.getValues(tab);

  // --- headers: keep the team's order, append anything missing ---
  const headers = (values[0] ?? []).map(norm);
  const writes = new Map<string, { row: number; col: number; value: string }>();
  const put = (row: number, col: number, value: string) => writes.set(`${row},${col}`, { row, col, value });
  for (const h of SHEET_COLUMNS) {
    if (!headers.includes(h)) {
      headers.push(h);
      put(1, headers.length, h);
    }
  }
  const col = (h: string) => headers.indexOf(h) + 1; // 1-based
  const cell = (row: number, h: string) => norm(values[row - 1]?.[col(h) - 1]);

  // --- index existing rows by Record ID ---
  const rowOf = new Map<string, number>();
  for (let r = 2; r <= values.length; r++) {
    const id = cell(r, "Record ID");
    if (id && !rowOf.has(id)) rowOf.set(id, r);
  }
  let nextRow = Math.max(values.length, 1) + 1;

  for (const g of store.grants()) {
    let row = rowOf.get(g.id);
    const isNew = row === undefined;
    if (isNew) row = nextRow++;
    let status = "";
    const last = (store.state.sheet_sync[g.id] ??= {});

    // ---- PULL ----
    if (!isNew) {
      const owner = cell(row!, HUMAN.owner);
      if (owner !== (last.owner ?? "") && owner !== "") {
        g.owner = owner;
        g.updated_at = now.toISOString();
        store.log({ at: now.toISOString(), grant_id: g.id, kind: "grant.updated", actor: "sheet-sync", detail: { changes: [{ field: "owner", to: owner }] } });
        last.owner = owner;
        result.ownersApplied++;
      }

      const raw = cell(row!, HUMAN.decision);
      if (raw !== "" && raw !== (last.decision ?? "")) {
        const d = normDecision(raw);
        const actor = cell(row!, HUMAN.decisionBy);
        if (!(DECISION_VALUES as readonly string[]).includes(d)) {
          status = `Rejected: "${raw}" is not valid. Use ${DECISION_VALUES.join(", ")}.`;
        } else if (!actor) {
          status = `Rejected: fill in "${HUMAN.decisionBy}" so the decision is attributable.`;
        } else if (store.latestDecision(g.id)?.decision === d) {
          last.decision = raw; // already recorded (e.g. via CLI); nothing to apply
        } else {
          try {
            recordDecision(store, {
              grantId: g.id, actorId: actor, decision: d as DecisionKind,
              ...(cell(row!, HUMAN.rationale) ? { rationale: cell(row!, HUMAN.rationale) } : {}),
              ...(cell(row!, HUMAN.overrideReason) ? { overrideReason: cell(row!, HUMAN.overrideReason) } : {}),
            }, now);
            last.decision = raw;
            result.decisionsApplied++;
          } catch (e) {
            status = `Rejected: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        if (status) result.rejected.push({ recordId: g.id, reason: status });
      }
    }

    // ---- PUSH ----
    const ctx = contextFor(store, g);
    for (const c of SYSTEM_COLUMNS) {
      const want = c.value(ctx);
      if (isNew || cell(row!, c.header) !== norm(want)) put(row!, col(c.header), want);
    }
    if (isNew || cell(row!, SYNC_STATUS_HEADER) !== status) put(row!, col(SYNC_STATUS_HEADER), status);

    // human columns: fill from the store unless a human edit is pending/rejected
    const human = humanValues(ctx);
    const pendingEdit = status !== "";
    for (const h of HUMAN_HEADERS) {
      const have = isNew ? "" : cell(row!, h);
      const want = human[h] ?? "";
      if (have === want) continue;
      const editedByHuman = h === HUMAN.owner ? have !== (last.owner ?? "") && have !== "" : h === HUMAN.decision && have !== (last.decision ?? "") && have !== "";
      if (pendingEdit || editedByHuman) continue; // never clobber a human edit
      if (h === HUMAN.decisionBy || h === HUMAN.rationale || h === HUMAN.overrideReason) {
        if (have !== "") continue; // supporting fields are fill-only-if-empty
      }
      put(row!, col(h), want);
    }
    last.owner = g.owner ?? last.owner;
    if (!pendingEdit) last.decision = human[HUMAN.decision] || last.decision;
    if (isNew) result.appended++;
  }

  const cells = [...writes.values()];
  if (cells.length) await client.writeCells(tab, cells);
  result.cellsWritten = cells.length;
  store.save();
  return result;
}
