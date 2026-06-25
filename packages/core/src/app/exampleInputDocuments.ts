export type ExampleInputDocumentKind = "text" | "markdown" | "csv" | "spreadsheet";

export interface ExampleInputDocument {
  id: string;
  name: string;
  filename: string;
  mediaType?: string;
  kind: ExampleInputDocumentKind;
  extractedText?: string;
  tablePreview?: string[][];
  notes?: string;
}

export interface ExampleInputDocumentSummary {
  id: string;
  name: string;
  filename: string;
  kind: ExampleInputDocumentKind;
  notes?: string;
}

const EXTENSION_TO_KIND: Record<string, ExampleInputDocumentKind> = {
  ".txt": "text",
  ".md": "markdown",
  ".csv": "csv",
  ".xlsx": "spreadsheet",
  ".xls": "spreadsheet"
};

export function isSupportedExampleInputDocument(filename: string): boolean {
  return inferExampleInputDocumentKind(filename) !== undefined;
}

export function inferExampleInputDocumentKind(
  filename: string
): ExampleInputDocumentKind | undefined {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return EXTENSION_TO_KIND[extension];
}

export function summarizeExampleInputDocument(
  document: ExampleInputDocument
): ExampleInputDocumentSummary {
  return {
    id: document.id,
    name: document.name,
    filename: document.filename,
    kind: document.kind,
    notes: document.notes
  };
}
