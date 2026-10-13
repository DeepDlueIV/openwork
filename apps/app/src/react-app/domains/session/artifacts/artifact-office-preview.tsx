/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { extractOfficeText, officeDocumentBody, officeSlides } from "@openwork/workbook";

import { PreviewLoading, PreviewUnavailable } from "./preview";

type OfficeFileKind = "docx" | "pptx";

/** Only the OOXML formats can be read in the app; .doc, .ppt, .odp and .key stay "Preview unavailable". */
export function officeKindFromPath(path: string): OfficeFileKind | null {
  const clean = (path.split(/[?#]/)[0] ?? path).toLowerCase();
  if (clean.endsWith(".pptx")) return "pptx";
  if (clean.endsWith(".docx")) return "docx";
  return null;
}

type OfficeTextState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "failed" };

function useOfficeText(kind: OfficeFileKind, data: ArrayBuffer): OfficeTextState {
  const [state, setState] = useState<OfficeTextState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    setState({ status: "loading" });
    extractOfficeText(kind, new Uint8Array(data))
      .then((text) => {
        if (!cancelled) setState({ status: "ready", text });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });

    return () => {
      cancelled = true;
    };
  }, [kind, data]);

  return state;
}

interface ArtifactOfficePreviewProps {
  path: string;
  data: ArrayBuffer;
}

/** Read-only text preview of a .pptx (slide outline) or .docx (document text), read in the app from the file bytes. */
export function ArtifactOfficePreview({ path, data }: ArtifactOfficePreviewProps) {
  const kind = officeKindFromPath(path);

  if (!kind) return <PreviewUnavailable />;

  return <OfficeTextPreview kind={kind} data={data} />;
}

function OfficeTextPreview({ kind, data }: { kind: OfficeFileKind; data: ArrayBuffer }) {
  const state = useOfficeText(kind, data);

  if (state.status === "loading") return <PreviewLoading />;
  if (state.status === "failed") return <PreviewUnavailable />;

  return kind === "pptx" ? <SlidesOutline text={state.text} /> : <DocumentText text={state.text} />;
}

function DocumentText({ text }: { text: string }) {
  return <div className="h-full overflow-auto whitespace-pre-wrap p-4 text-sm leading-6 text-foreground">{officeDocumentBody(text)}</div>;
}

function SlidesOutline({ text }: { text: string }) {
  const slides = useMemo(() => officeSlides(text), [text]);

  if (slides.length === 0) return <DocumentText text={text} />;

  return (
    <ol className="flex h-full flex-col gap-3 overflow-auto p-4">
      {slides.map((slide, index) => {
        const [title = "", ...lines] = slide.body.split("\n").map((line) => line.trim()).filter(Boolean);

        return (
          <li key={slide.part} className="flex flex-col gap-1">
            <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
            <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-3">
              <p className="text-sm font-semibold text-foreground">{title}</p>
              {lines.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {lines.slice(0, 8).map((line, lineIndex) => (
                    <li key={lineIndex} className="text-xs leading-5 text-muted-foreground">{line}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
