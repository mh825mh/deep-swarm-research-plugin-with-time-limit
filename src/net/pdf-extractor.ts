/**
 * @file net/pdf-extractor.ts
 * Handles PDF detection, text extraction, and embedded image extraction.
 *
 * When a URL serves a PDF (detected via Content-Type header or URL pattern),
 * this module extracts clean text + embedded images from the PDF instead of
 * passing raw binary bytes through the HTML extractor (which produces garbled output).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ExtractedPage, Outlink } from "../types";
import { DESCRIPTION_FALLBACK_CHARS } from "../constants";

let _PDFParse: any = null;
let _attempted = false;

/**
 * Returns the PDFParse constructor from pdf-parse, or null if unavailable.
 */
function getPDFParse(): any {
  if (_attempted) return _PDFParse;
  _attempted = true;
  try {
    const mod = require("pdf-parse");
    _PDFParse = mod.PDFParse ?? mod.default?.PDFParse ?? mod.default ?? mod;
  } catch {
    _PDFParse = null;
  }
  return _PDFParse;
}

const PDF_URL_RE = /\.pdf(\?.*)?$/i;

const PDF_HOST_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /arxiv\.org\/pdf\//i,
  /arxiv\.org\/ftp\//i,
  /biorxiv\.org\/content\/.*\.full\.pdf/i,
  /medrxiv\.org\/content\/.*\.full\.pdf/i,
  /papers\.ssrn\.com\/sol3\/Delivery\.cfm/i,
  /dl\.acm\.org\/doi\/pdf\//i,
  /ieeexplore\.ieee\.org\/stampPDF/i,
  /link\.springer\.com\/content\/pdf\//i,
  /pdfs\.semanticscholar\.org\//i,
  /openreview\.net\/pdf/i,
  /proceedings\.neurips\.cc\/paper_files\/.*\.pdf/i,
  /aclanthology\.org\/.*\.pdf/i,
  /pnas\.org\/doi\/pdf\//i,
  /science\.org\/doi\/pdf\//i,
  /nature\.com\/articles\/.*\.pdf/i,
  /researchgate\.net\/.*\/download/i,
];

export function isPdfUrl(url: string): boolean {
  if (PDF_URL_RE.test(url)) return true;
  return PDF_HOST_PATH_PATTERNS.some((re) => re.test(url));
}

export function isPdfContentType(
  contentType: string | null | undefined,
): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return (
    lower.includes("application/pdf") || lower.includes("application/x-pdf")
  );
}

export interface PdfImage {
  readonly page: number;
  readonly format: string;
  readonly filePath: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
}

/**
 * Extracts text (and optionally images) from a PDF buffer using pdf-parse v2.
 *
 * extractImages defaults to false because image extraction requires the
 * optional @napi-rs/canvas native binding.  Enable it only when you know the
 * binding is available (i.e. the warning "Cannot load @napi-rs/canvas" does
 * NOT appear in the LM Studio plugin log).
 */
export async function extractPdf(
  buffer: Buffer,
  sourceUrl: string,
  finalUrl: string,
  contentLimit: number,
  extractImages: boolean = false,
  maxImages: number = 20,
  page: number = 1,
): Promise<
  ExtractedPage & {
    images: ReadonlyArray<PdfImage>;
    pageCount: number;
    pdfAuthor: string | null;
  }
> {
  const PDFParseClass = getPDFParse();
  if (!PDFParseClass) {
    throw new Error(
      "pdf-parse could not be loaded (missing browser polyfills or native deps). " +
      "PDF text extraction is unavailable.",
    );
  }

  const data = new Uint8Array(buffer);
  const parser = new PDFParseClass({ data } as any);

  let rawText = "";
  let title = "";
  let author = "";
  let pageCount = 0;
  let creationDate: string | null = null;

  try {
    const info = await parser.getInfo();
    pageCount = info.total || 0;

    if (info.info) {
      title = sanitizeMetaString(info.info.Title) || "";
      author = sanitizeMetaString(info.info.Author) || "";
      creationDate = extractDateFromPdfInfo(info.info);
    }

    const textResult = await parser.getText({
      lineEnforce: true,
      lineThreshold: 5,
    });
    rawText = textResult.text || "";
  } catch (err) {
    throw new Error(
      `PDF parsing failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const cleanedText = cleanPdfText(rawText);
  const start = (page - 1) * contentLimit;
  const end = start + contentLimit;
  const truncatedText = cleanedText.slice(start, end);

  if (!title) {
    title = inferTitleFromText(cleanedText);
  }

  const images: PdfImage[] = [];
  if (extractImages) {
    try {
      const imageResult = await parser.getImage({
        imageThreshold: 50,
        imageDataUrl: true,
        imageBuffer: true,
      } as any);

      if (imageResult?.pages) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-images-"));

        for (const page of imageResult.pages) {
          if (images.length >= maxImages) break;
          if (!(page as any).images) continue;
          for (const img of (page as any).images) {
            if (images.length >= maxImages) break;

            const imgWidth = img.width || 0;
            const imgHeight = img.height || 0;

            let imgBuffer: Buffer | null = null;
            let format = "png";

            if (img.data && img.data.length > 0) {
              imgBuffer = Buffer.from(img.data);
            } else if (img.dataUrl) {
              const match = (img.dataUrl as string).match(
                /^data:image\/(\w+);base64,(.+)$/,
              );
              if (match) {
                format = match[1];
                imgBuffer = Buffer.from(match[2], "base64");
              }
            }

            if (!imgBuffer || imgBuffer.length < 200) continue;

            const fileName = `page${(page as any).pageNumber || 1}_img${images.length + 1}.${format}`;
            const filePath = path.join(tmpDir, fileName);
            fs.writeFileSync(filePath, imgBuffer);

            images.push({
              page: (page as any).pageNumber || 1,
              format,
              filePath,
              width: imgWidth,
              height: imgHeight,
              byteSize: imgBuffer.length,
            });
          }
        }
      }
    } catch {
    }
  }

  await parser.destroy();

  const wordCount = countWords(truncatedText);
  const description = buildDescription(title, author, pageCount, cleanedText);

  return {
    url: sourceUrl,
    finalUrl,
    title,
    description,
    published: creationDate,
    text: truncatedText,
    wordCount,
    outlinks: extractUrlsFromText(cleanedText, finalUrl),
    images,
    pageCount,
    pdfAuthor: author || null,
    page,
    totalPages: Math.ceil(cleanedText.length / contentLimit),
  };
}

function cleanPdfText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/(\w)-\n(\w)/g, "$1$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\s*\d+\s*\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function inferTitleFromText(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 5);
  if (lines.length === 0) return "";
  const candidate = lines[0].trim();
  return candidate.length <= 200 ? candidate : candidate.slice(0, 200);
}

function sanitizeMetaString(val: unknown): string {
  if (typeof val !== "string") return "";
  return val.replace(/\0/g, "").trim();
}

function extractDateFromPdfInfo(info: Record<string, unknown>): string | null {
  for (const key of ["CreationDate", "ModDate", "created", "modified"]) {
    const raw = info[key];
    if (typeof raw !== "string" || !raw) continue;

    const pdfDateMatch = raw.match(/D:(\d{4})(\d{2})(\d{2})/);
    if (pdfDateMatch) {
      return `${pdfDateMatch[1]}-${pdfDateMatch[2]}-${pdfDateMatch[3]}`;
    }

    try {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    } catch {
      continue;
    }
  }
  return null;
}

function buildDescription(
  title: string,
  author: string,
  pageCount: number,
  text: string,
): string {
  const parts: string[] = [];
  if (title) parts.push(title);
  if (author) parts.push(`by ${author}`);
  if (pageCount > 0) parts.push(`(${pageCount} pages)`);

  const metaLine = parts.length > 0 ? parts.join(" ") + ". " : "";
  const textPreview = text.slice(0, DESCRIPTION_FALLBACK_CHARS - metaLine.length);
  return (metaLine + textPreview).slice(0, DESCRIPTION_FALLBACK_CHARS);
}

function extractUrlsFromText(
  text: string,
  baseUrl: string,
): ReadonlyArray<Outlink> {
  const urlRe = /https?:\/\/[^\s)<>"']+/gi;
  const matches = text.match(urlRe) || [];
  const seen = new Set<string>();
  const links: Outlink[] = [];

  let baseHost: string;
  try {
    baseHost = new URL(baseUrl).hostname;
  } catch {
    baseHost = "";
  }

  for (const rawUrl of matches) {
    if (links.length >= 20) break;
    const cleanUrl = rawUrl.replace(/[.,;:!?)]+$/, "");
    if (seen.has(cleanUrl)) continue;
    try {
      const parsed = new URL(cleanUrl);
      if (parsed.hostname === baseHost) continue;
      seen.add(cleanUrl);
      links.push({
        text: parsed.hostname + parsed.pathname.slice(0, 60),
        href: cleanUrl,
      });
    } catch {
      continue;
    }
  }
  return links;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}