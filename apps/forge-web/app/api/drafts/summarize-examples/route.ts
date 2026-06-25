// POST /api/drafts/summarize-examples
//
// Accepts multipart/form-data with one or more `file` fields (txt/md/csv) and
// an optional per-file `notes[<name>]` field. Calls core's
// `summarizeExampleInputDocument` for each uploaded file and returns an array
// of ExampleInputDocumentSummary objects. The summaries are suitable for
// feeding into the AI draft-generation flow as context.
//
// Size cap: 256 KB per file; 1 MB total. Files larger than that are rejected.
// Allowed MIME / extensions: text/plain, text/markdown, text/csv (.txt .md .csv).
//
// The client (BuildSection AI tab) uploads files, receives summaries, then
// includes them in the draft-generation request body under `exampleDocuments`.
import { withUser } from "@/lib/api";
import { NextResponse } from "next/server";
import { inferExampleInputDocumentKind, summarizeExampleInputDocument } from "@agentkitforge/core";
import type { ExampleInputDocument } from "@agentkitforge/core";

export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 256 * 1024; // 256 KB per file
const MAX_TOTAL_BYTES = 1024 * 1024; // 1 MB total
const MAX_FILES = 10;

const ALLOWED_EXTS = new Set([".txt", ".md", ".csv"]);

function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

export async function POST(request: Request) {
  return withUser(async () => {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data")) {
      return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
    }

    const form = await request.formData();
    const files = form.getAll("file") as File[];

    if (files.length === 0) {
      return NextResponse.json({ summaries: [] });
    }
    if (files.length > MAX_FILES) {
      return NextResponse.json({ error: `Too many files (max ${MAX_FILES}).` }, { status: 400 });
    }

    let totalBytes = 0;
    const summaries = [];

    for (const file of files) {
      const ext = extOf(file.name);
      if (!ALLOWED_EXTS.has(ext)) {
        return NextResponse.json(
          { error: `File "${file.name}" has unsupported extension (allowed: .txt .md .csv).` },
          { status: 400 }
        );
      }

      if (file.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: `File "${file.name}" is too large (max 256 KB).` },
          { status: 400 }
        );
      }
      totalBytes += file.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        return NextResponse.json({ error: "Total upload size exceeds 1 MB." }, { status: 400 });
      }

      const kind = inferExampleInputDocumentKind(file.name);
      if (!kind) {
        return NextResponse.json({ error: `Cannot infer kind for "${file.name}".` }, { status: 400 });
      }

      const text = await file.text();
      const notes = (form.get(`notes[${file.name}]`) as string | null) ?? undefined;

      const doc: ExampleInputDocument = {
        id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        filename: file.name,
        kind,
        extractedText: text.slice(0, 8000), // cap for safety
        notes
      };

      summaries.push(summarizeExampleInputDocument(doc));
    }

    return { summaries };
  });
}
