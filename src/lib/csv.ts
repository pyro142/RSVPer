// CSV parsing (import) and building (export).

/**
 * Parse RFC 4180 CSV. Handles quoted fields, escaped quotes, CRLF/LF, and a
 * leading UTF-8 BOM (Excel adds one). Returns rows of strings.
 */
export function parseCsv(text: string, maxRows = 5000): string[][] {
  const input = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    if (rows.length > maxRows) throw new Error(`Too many rows (max ${maxRows}).`);
  };

  while (i < input.length) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      endRow();
      if (ch === '\r' && input[i + 1] === '\n') i++;
    } else {
      field += ch;
    }
    i++;
  }
  if (quoted) throw new Error('Unclosed quote in CSV.');
  if (field !== '' || row.length) endRow();
  return rows;
}

/**
 * Quote one cell and defuse spreadsheet formula injection: a guest who types
 * =HYPERLINK(...) as a plus one's name must not have it evaluated when the
 * export opens in Excel or Sheets.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function csvDocument(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  // BOM so Excel opens the file as UTF-8 and accented names survive.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'no-store',
    },
  });
}

export function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
