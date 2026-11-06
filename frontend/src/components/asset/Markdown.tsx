// A small, safe Markdown renderer for descriptions: it builds React elements (never raw HTML), so synced or
// user-authored text cannot inject markup. Supports headings, paragraphs, lists, fenced code, block quotes,
// inline code, bold, italic and http(s)/mailto links.
import { Fragment, type ReactNode } from "react";
import { cx } from "../../lib/cx";

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // order matters: code first (no formatting inside), then links, bold, italic
  const pattern = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = m[0];
    const key = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={key} className="rounded bg-muted px-1 py-px font-mono text-[0.92em]">{token.slice(1, -1)}</code>);
    else if (m[2]) {
      const lm = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const label = lm?.[1] ?? token;
      const url = lm?.[2] ?? "";
      out.push(
        SAFE_URL.test(url) ? (
          <a key={key} href={url} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
            {label}
          </a>
        ) : (
          <Fragment key={key}>{label}</Fragment>
        ),
      );
    } else if (m[3] || m[4]) out.push(<strong key={key} className="font-semibold">{inline(token.slice(2, -2), key)}</strong>);
    else out.push(<em key={key}>{inline(token.slice(1, -1), key)}</em>);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string };

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      i += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push({ kind: "h", level: h[1].length, text: h[2] });
      i += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
      blocks.push({ kind: "ul", items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push({ kind: "ol", items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*[-*+]\s|\s*\d+[.)]\s|\s*>|```)/.test(lines[i])) para.push(lines[i++].trim());
    blocks.push({ kind: "p", text: para.join(" ") });
  }
  return blocks;
}

const H_CLASS = ["", "text-ui-lg font-bold", "text-ui-md font-bold", "text-ui-base font-bold", "text-ui-base font-semibold"];

export default function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className={cx("space-y-2 break-words text-ui-base leading-relaxed", className)}>
      {blocks.map((b, bi) => {
        const k = `b${bi}`;
        switch (b.kind) {
          case "h": {
            const Tag = (b.level <= 2 ? "h3" : "h4") as "h3" | "h4";
            return <Tag key={k} className={cx("mt-1", H_CLASS[b.level])}>{inline(b.text, k)}</Tag>;
          }
          case "ul":
            return (
              <ul key={k} className="ml-5 list-disc space-y-0.5">
                {b.items.map((it, ii) => <li key={ii}>{inline(it, `${k}-${ii}`)}</li>)}
              </ul>
            );
          case "ol":
            return (
              <ol key={k} className="ml-5 list-decimal space-y-0.5">
                {b.items.map((it, ii) => <li key={ii}>{inline(it, `${k}-${ii}`)}</li>)}
              </ol>
            );
          case "code":
            return <pre key={k} className="overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-ui-sm">{b.text}</pre>;
          case "quote":
            return <blockquote key={k} className="border-l-2 border-primary/50 pl-3 text-muted-foreground">{inline(b.text, k)}</blockquote>;
          default:
            return <p key={k}>{inline(b.text, k)}</p>;
        }
      })}
    </div>
  );
}
