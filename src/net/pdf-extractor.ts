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

/**
 * Installs stub implementations of the three browser globals that pdf.js
 * references during module initialisation.  Must be called before the first
 * require("pdf-parse").  Safe to call multiple times.
 */
export function installBrowserPolyfills(): void {
  const g = globalThis as any;

  if (!g.DOMMatrix) {
    g.DOMMatrix = class DOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      m11 = 1; m12 = 0; m13 = 0; m14 = 0;
      m21 = 0; m22 = 1; m23 = 0; m24 = 0;
      m31 = 0; m32 = 0; m33 = 1; m34 = 0;
      m41 = 0; m42 = 0; m43 = 0; m44 = 1;
      is2D = true; isIdentity = true;
      constructor(_init?: string | number[]) { }
      multiply(_m: any) { return new g.DOMMatrix(); }
      translate(_tx = 0, _ty = 0, _tz = 0) { return new g.DOMMatrix(); }
      scale(_sx = 1, _sy?: number, _sz?: number, _ox = 0, _oy = 0, _oz = 0) { return new g.DOMMatrix(); }
      scale3d(_s = 1, _ox = 0, _oy = 0, _oz = 0) { return new g.DOMMatrix(); }
      rotate(_rx = 0, _ry?: number, _rz?: number) { return new g.DOMMatrix(); }
      rotateAxisAngle(_x = 0, _y = 0, _z = 0, _angle = 0) { return new g.DOMMatrix(); }
      skewX(_sx = 0) { return new g.DOMMatrix(); }
      skewY(_sy = 0) { return new g.DOMMatrix(); }
      flipX() { return new g.DOMMatrix(); }
      flipY() { return new g.DOMMatrix(); }
      inverse() { return new g.DOMMatrix(); }
      transformPoint(p?: any) { return p ?? { x: 0, y: 0, z: 0, w: 1 }; }
      toFloat32Array() { return new Float32Array(16); }
      toFloat64Array() { return new Float64Array(16); }
      toJSON() { return {}; }
      toString() { return "matrix(1, 0, 0, 1, 0, 0)"; }
    };
  }

  if (!g.ImageData) {
    g.ImageData = class ImageData {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
      readonly colorSpace = "srgb";
      constructor(
        dataOrWidth: Uint8ClampedArray | number,
        widthOrHeight: number,
        heightOrSettings?: number | { colorSpace?: string },
      ) {
        if (typeof dataOrWidth === "number") {
          const h =
            typeof heightOrSettings === "number" ? heightOrSettings : widthOrHeight;
          this.data = new Uint8ClampedArray(dataOrWidth * h * 4);
          this.width = dataOrWidth;
          this.height = h;
        } else {
          this.data = dataOrWidth;
          this.width = widthOrHeight;
          this.height =
            typeof heightOrSettings === "number"
              ? heightOrSettings
              : Math.floor(dataOrWidth.length / 4 / widthOrHeight);
        }
      }
    };
  }

  if (!g.Path2D) {
    g.Path2D = class Path2D {
      constructor(_path?: string | any) { }
      addPath(_path: any, _transform?: any) { }
      closePath() { }
      moveTo(_x: number, _y: number) { }
      lineTo(_x: number, _y: number) { }
      arc(_cx: number, _cy: number, _r: number, _sa: number, _ea: number, _ccw?: boolean) { }
      arcTo(_x1: number, _y1: number, _x2: number, _y2: number, _r: number) { }
      ellipse(_cx: number, _cy: number, _rx: number, _ry: number, _rot: number, _sa: number, _ea: number, _ccw?: boolean) { }
      bezierCurveTo(_cp1x: number, _cp1y: number, _cp2x: number, _cp2y: number, _x: number, _y: number) { }
      quadraticCurveTo(_cpx: number, _cpy: number, _x: number, _y: number) { }
      rect(_x: number, _y: number, _w: number, _h: number) { }
      roundRect(_x: number, _y: number, _w: number, _h: number, _radii?: any) { }
    };
  }
}

let _PDFParse: any = null;
let _attempted = false;

/**
 * Returns the PDFParse constructor from pdf-parse, or null if unavailable.
 * Installs polyfills before the first require() call.
 */
function getPDFParse(): any {
  if (_attempted) return _PDFParse;
  _attempted = true;
  installBrowserPolyfills();
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