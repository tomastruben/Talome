"use client";

export function PDFPreview({ streamUrl, fileName }: { streamUrl: string; fileName: string }) {
  return (
    <iframe
      src={streamUrl}
      className="w-full h-full min-h-[60vh] border-0"
      title={fileName}
    />
  );
}
