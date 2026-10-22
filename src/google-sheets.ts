import { GoogleAuth } from "google-auth-library";
import { DECISION_VALUES, HUMAN, SHEET_COLUMNS, SYSTEM_HEADERS } from "./sheet.js";
import type { SheetsClient } from "./sheets-sync.js";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const PROTECT_TAG = "ImpactOS system column";

export interface GoogleSheetsOptions {
  spreadsheetId: string;
  /** Override for tests. Default: Application Default Credentials / GOOGLE_APPLICATION_CREDENTIALS service account. */
  getToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

/** 1 -> A, 27 -> AA */
export function colLetter(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

export class GoogleSheetsClient implements SheetsClient {
  private readonly id: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GoogleSheetsOptions) {
    this.id = opts.spreadsheetId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.getToken = opts.getToken ?? (async () => {
      const token = await new GoogleAuth({ scopes: [SCOPE] }).getAccessToken();
      if (!token) throw new Error("No Google credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account key file (see docs/google-sheets.md).");
      return token;
    });
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${API}/${this.id}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.getToken()}`, "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const hint = res.status === 403 || res.status === 404 ? " (is the spreadsheet shared with the service account's email as Editor?)" : "";
      throw new Error(`Google Sheets API ${res.status}${hint}: ${(await res.text()).slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async getValues(tab: string): Promise<string[][]> {
    const r = await this.call<{ values?: unknown[][] }>(`/values/${encodeURIComponent(`${quote(tab)}!A1:ZZ`)}?majorDimension=ROWS`);
    return (r.values ?? []).map((row) => row.map((v) => String(v ?? "")));
  }

  /** valueInputOption RAW: text is stored literally, so "=IMPORTDATA(...)" in a newsletter can never run as a formula. */
  async writeCells(tab: string, cells: { row: number; col: number; value: string }[]): Promise<void> {
    for (let i = 0; i < cells.length; i += 500) {
      const data = cells.slice(i, i + 500).map((c) => ({ range: `${quote(tab)}!${colLetter(c.col)}${c.row}`, values: [[c.value]] }));
      await this.call(`/values:batchUpdate`, { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data }) });
    }
  }

  /**
   * One-time (idempotent) tab preparation: create the tab, write headers, freeze the header row,
   * add a decision dropdown, and put warning-only protection on system columns.
   */
  async setup(tab: string): Promise<void> {
    type Meta = { sheets: { properties: { sheetId: number; title: string }; protectedRanges?: { description?: string }[] }[] };
    let meta = await this.call<Meta>(`?fields=sheets(properties(sheetId,title),protectedRanges(description))`);
    let sheet = meta.sheets.find((s) => s.properties.title === tab);
    if (!sheet) {
      await this.call(`:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }) });
      meta = await this.call<Meta>(`?fields=sheets(properties(sheetId,title),protectedRanges(description))`);
      sheet = meta.sheets.find((s) => s.properties.title === tab)!;
    }
    const sheetId = sheet.properties.sheetId;

    const existing = await this.getValues(tab);
    const headers = (existing[0] ?? []).map((h) => h.trim());
    const missing = SHEET_COLUMNS.filter((h) => !headers.includes(h));
    await this.writeCells(tab, missing.map((h, i) => ({ row: 1, col: headers.length + i + 1, value: h })));
    const all = [...headers, ...missing];

    const requests: object[] = [
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
    ];
    const decisionCol = all.indexOf(HUMAN.decision);
    if (decisionCol >= 0) {
      requests.push({
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: decisionCol, endColumnIndex: decisionCol + 1 },
          rule: { condition: { type: "ONE_OF_LIST", values: DECISION_VALUES.map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: true },
        },
      });
    }
    const already = new Set((sheet.protectedRanges ?? []).map((p) => p.description));
    for (const h of SYSTEM_HEADERS) {
      const i = all.indexOf(h);
      const description = `${PROTECT_TAG}: ${h}`;
      if (i < 0 || already.has(description)) continue;
      requests.push({
        addProtectedRange: {
          protectedRange: { range: { sheetId, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 }, description, warningOnly: true },
        },
      });
    }
    await this.call(`:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
  }
}
