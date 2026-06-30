import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import process from "process";

// ── Fonts ─────────────────────────────────────────────────────────────────────
const FONT_REG  = "C:\\Windows\\Fonts\\ARIALUNI.ttf";
const FONT_BOLD = "C:\\Windows\\Fonts\\arialbd.ttf";

// ── Colors ────────────────────────────────────────────────────────────────────
const C_HEADER_BG   = "#1A67A3";
const C_HEADER_TEXT  = "#FFFFFF";
const C_SECT_BG      = "#EEF2F7";
const C_SECT_LABEL   = "#4A6785";
const C_BORDER       = "#C8D4E3";
const C_TEXT         = "#1E2A38";
const C_MUTED        = "#5A6A7A";
const C_BADGE_TEXT   = "#1A67A3";
const C_ACT_NUM_BG   = "#1A67A3";
const C_ACT_DATE     = "#5A6A7A";
const C_FOOTER_BG    = "#F0F4FA";
const C_FOOTER_TEXT  = "#5A6A7A";

// ── Layout (A4 portrait) ──────────────────────────────────────────────────────
const PW     = 595.28;
const PH     = 841.89;
const ML     = 28;
const MT     = 28;
const MB     = 28;
const FOOTER = 24;
const HDR    = 52;
const BODY_Y = MT + HDR + 6;
const MAX_Y  = PH - MB - FOOTER - 10;   // usable bottom
const FULL_W = PW - ML * 2;             // full-width content

// ── Data types ────────────────────────────────────────────────────────────────
export interface ActivityData {
    version: number;
    date: string;
    author: string;
    comment?: string;
    details?: string[];
}

export interface WorkPackageData {
    id: number;
    subject: string;
    status?: string;
    assignee?: string;
    accountable?: string;
    estimatedTime?: string;
    remainingTime?: string;
    percentageDone?: number | null;
    spentTime?: string;
    priority?: string;
    startDate?: string;
    dueDate?: string;
    category?: string;
    version?: string;
    description?: string;
    projectName?: string;
    images?: Map<string, Buffer>;
    activities?: ActivityData[];
}

// ── Segment types (parsed content) ────────────────────────────────────────────
type Segment =
    | { kind: "text"; text: string; heading?: 1 | 2 | 3 }
    | { kind: "bullet"; text: string; checked?: boolean; isCheckbox?: boolean }
    | { kind: "br" }
    | { kind: "img"; src: string };

// ── Low-level drawing helpers ─────────────────────────────────────────────────

function rect(doc: InstanceType<typeof PDFDocument>, x: number, y: number, w: number, h: number, color: string, radius = 0) {
    doc.save().roundedRect(x, y, w, h, radius).fill(color).restore();
}

function hline(doc: InstanceType<typeof PDFDocument>, x1: number, x2: number, y: number, color = C_BORDER) {
    doc.save().moveTo(x1, y).lineTo(x2, y).strokeColor(color).lineWidth(0.5).stroke().restore();
}

/** Draw a full-width attribute table at the top of page 1. Returns the y after the table. */
function drawAttrTable(doc: InstanceType<typeof PDFDocument>, data: WorkPackageData, startY: number): number {
    const tableX = ML;
    const tableW = FULL_W;
    const colW = tableW / 2;
    const rowH = 16;
    const labelW = 78;
    let y = startY;

    // Section header helper
    const sectHead = (title: string) => {
        rect(doc, tableX, y, tableW, 18, C_SECT_BG);
        doc.font("Bold").fontSize(7.5).fillColor(C_SECT_LABEL).text(title.toUpperCase(), tableX + 6, y + 5, { width: tableW - 10 });
        hline(doc, tableX, tableX + tableW, y + 18, C_BORDER);
        y += 18;
    };

    // Row helper: draws a pair of label-value in left and right half
    const rowPair = (l1: string, v1: string, l2: string, v2: string, bg: boolean) => {
        if (bg) rect(doc, tableX, y, tableW, rowH, "#F7F9FC");
        doc.font("Regular").fontSize(7.5).fillColor(C_SECT_LABEL).text(l1, tableX + 6, y + 4, { width: labelW });
        doc.font("Regular").fontSize(7.5).fillColor(C_TEXT).text(v1 || "—", tableX + labelW + 6, y + 4, { width: colW - labelW - 12 });
        doc.font("Regular").fontSize(7.5).fillColor(C_SECT_LABEL).text(l2, tableX + colW + 6, y + 4, { width: labelW });
        doc.font("Regular").fontSize(7.5).fillColor(C_TEXT).text(v2 || "—", tableX + colW + labelW + 6, y + 4, { width: colW - labelW - 12 });
        y += rowH;
    };

    // Border around the whole table
    const tableStartY = y;

    // People
    sectHead("People");
    rowPair("Assignee", data.assignee || "", "Accountable", data.accountable || "", false);
    hline(doc, tableX, tableX + tableW, y, C_BORDER);

    // Estimates & Progress
    sectHead("Estimates & Progress");
    rowPair("Work", data.estimatedTime || "", "Remaining", data.remainingTime || "", false);
    rowPair("% Complete", data.percentageDone != null ? `${data.percentageDone}%` : "", "Spent time", data.spentTime || "0h", true);
    hline(doc, tableX, tableX + tableW, y, C_BORDER);

    // Details
    sectHead("Details");
    const dateVal = data.startDate && data.dueDate ? `${data.startDate} - ${data.dueDate}` : (data.startDate || data.dueDate || "");
    rowPair("Priority", data.priority || "", "Date", dateVal, false);
    rowPair("Category", data.category || "", "Version", data.version || "", true);
    hline(doc, tableX, tableX + tableW, y, C_BORDER);

    // Costs
    sectHead("Costs");
    rowPair("Spent units", "", "Labor costs", "", false);
    rowPair("Unit costs", "", "Overall costs", "", true);
    rowPair("Budget", "", "", "", false);
    hline(doc, tableX, tableX + tableW, y, C_BORDER);

    // Outer border
    doc.save().rect(tableX, tableStartY, tableW, y - tableStartY).strokeColor(C_BORDER).lineWidth(0.5).stroke().restore();
    // Vertical center divider
    doc.save().moveTo(tableX + colW, tableStartY).lineTo(tableX + colW, y).strokeColor(C_BORDER).lineWidth(0.3).stroke().restore();

    return y;
}

function drawHeader(doc: InstanceType<typeof PDFDocument>, data: WorkPackageData) {
    rect(doc, 0, 0, PW, MT + HDR, C_HEADER_BG);
    const taskLabel = `Task #${data.id}`;
    doc.font("Bold").fontSize(8.5).fillColor("#AAC8E8").text(taskLabel, ML, MT + 8);
    const labelW = doc.widthOfString(taskLabel) + 6;
    if (data.status) {
        const badgeX = ML + labelW + 4;
        const badgeW = doc.font("Regular").fontSize(7.5).widthOfString(data.status) + 12;
        doc.save().roundedRect(badgeX, MT + 6, badgeW, 14, 3).fillColor("#2B87D0").fill().restore();
        doc.font("Regular").fontSize(7.5).fillColor("#FFFFFF").text(data.status, badgeX + 6, MT + 9);
    }
    doc.font("Bold").fontSize(13).fillColor(C_HEADER_TEXT).text(data.subject, ML, MT + 22, { width: PW - ML * 2, lineGap: 1 });
}

function drawFooter(doc: InstanceType<typeof PDFDocument>, data: WorkPackageData, pageNum: number) {
    const y = PH - MB - FOOTER;
    rect(doc, 0, y, PW, FOOTER + MB, C_FOOTER_BG);
    hline(doc, 0, PW, y, C_BORDER);
    const today = new Date().toLocaleDateString("vi-VN");
    doc.font("Regular").fontSize(7.5).fillColor(C_FOOTER_TEXT).text(today, ML, y + 8, { width: 80 });
    const center = data.projectName || "";
    doc.font("Regular").fontSize(7.5).fillColor(C_FOOTER_TEXT).text(center, (PW - doc.widthOfString(center)) / 2, y + 8);
    doc.font("Regular").fontSize(7.5).fillColor(C_FOOTER_TEXT).text(String(pageNum), PW - ML - 20, y + 8, { width: 20, align: "right" });
}


// ── HTML → segments parser ────────────────────────────────────────────────────

function parseHtml(html: string): Segment[] {
    const segs: Segment[] = [];
    const IMG_PH = "\x00IMG\x00";

    const decode = (s: string) =>
        s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
         .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
         .replace(/&quot;/g, '"');

    let src = html;

    // 1. Extract images first
    const imgMap = new Map<string, string>();
    let imgIdx = 0;
    src = src.replace(/<img[^>]+src="([^"]*)"[^>]*\/?>/gi, (_, imgSrc) => {
        const key = `${IMG_PH}${imgIdx++}${IMG_PH}`;
        imgMap.set(key, imgSrc);
        return `\n${key}\n`;
    });

    // 2. Checkbox li items
    src = src.replace(
        /<li[^>]*>\s*(?:<p[^>]*>)?\s*<input[^>]+type="checkbox"([^>]*)>\s*([\s\S]*?)(?:<\/p>)?\s*<\/li>/gi,
        (_, attrs, content) => {
            const checked = /checked/i.test(attrs) ? "☑" : "☐";
            return `\n${checked} ${content.replace(/<[^>]+>/g, "").trim()}\n`;
        }
    );

    // 3. li > p merge
    src = src.replace(/<li[^>]*>\s*<p[^>]*>/gi, "\n• ");

    // 4. Block closers → newline
    src = src.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<\/li>/gi, "\n")
             .replace(/<\/div>/gi, "\n").replace(/<\/figure>/gi, "\n").replace(/<\/blockquote>/gi, "\n")
             .replace(/<\/h[1-6]>/gi, "\n");

    // 5. Structural opens
    src = src.replace(/<h1[^>]*>/gi, "\n__H1__").replace(/<h2[^>]*>/gi, "\n__H2__").replace(/<h3[^>]*>/gi, "\n__H3__")
             .replace(/<li[^>]*>/gi, "\n• ").replace(/<blockquote[^>]*>/gi, "\n").replace(/<figure[^>]*>/gi, "\n")
             .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "$1")
             .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "$1")
             .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "$1");

    // 6. Strip all remaining tags + decode entities
    src = decode(src.replace(/<[^>]+>/g, ""));

    // 7. Collapse blank lines
    src = src.replace(/\n{3,}/g, "\n\n");

    for (let line of src.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) { segs.push({ kind: "br" }); continue; }

        if (trimmed.startsWith(IMG_PH) && trimmed.endsWith(IMG_PH)) {
            const imgSrc = imgMap.get(trimmed);
            if (imgSrc) segs.push({ kind: "img", src: imgSrc });
            continue;
        }
        if (trimmed.startsWith("__H1__")) { segs.push({ kind: "text", text: trimmed.slice(6).trim(), heading: 1 }); }
        else if (trimmed.startsWith("__H2__")) { segs.push({ kind: "text", text: trimmed.slice(6).trim(), heading: 2 }); }
        else if (trimmed.startsWith("__H3__")) { segs.push({ kind: "text", text: trimmed.slice(6).trim(), heading: 3 }); }
        else if (trimmed.startsWith("☑ ") || trimmed.startsWith("☐ ")) {
            segs.push({ kind: "bullet", text: trimmed.slice(2), checked: trimmed.startsWith("☑"), isCheckbox: true });
        }
        else if (trimmed.startsWith("• ")) {
            const text = trimmed.slice(2).trim();
            if (text) segs.push({ kind: "bullet", text });
        }
        else { segs.push({ kind: "text", text: trimmed }); }
    }

    return segs.filter((s, i) => !(s.kind === "br" && i > 0 && segs[i - 1].kind === "br"));
}

// ── Multi-page segment renderer ───────────────────────────────────────────────

interface RenderCtx {
    doc: InstanceType<typeof PDFDocument>;
    data: WorkPackageData;
    images: Map<string, Buffer>;
    x: number;
    maxW: number;
    y: number;
    pageNum: number;
}

/** Start a new page, draw header, return new y */
function newPage(ctx: RenderCtx): number {
    drawFooter(ctx.doc, ctx.data, ctx.pageNum);
    ctx.doc.addPage();
    ctx.pageNum++;
    drawHeader(ctx.doc, ctx.data);
    return BODY_Y + 4;
}

/** Estimate height of a single segment */
function segHeight(doc: InstanceType<typeof PDFDocument>, seg: Segment, maxW: number, images: Map<string, Buffer>): number {
    if (seg.kind === "br") return 4;
    if (seg.kind === "img") {
        const buf = images.get(seg.src);
        if (!buf) return 0;
        try {
            const imgObj = (doc as any).openImage(buf);
            const natW: number = imgObj.width ?? 400;
            const natH: number = imgObj.height ?? 300;
            const scale = Math.min(1, (maxW - 8) / natW, 300 / natH);
            return Math.round(natH * scale) + 8;
        } catch { return 0; }
    }
    if (seg.kind === "text") {
        const font = (seg.heading ?? 0) > 0 ? "Bold" : "Regular";
        const size = seg.heading === 1 ? 11 : seg.heading === 2 ? 9.5 : seg.heading === 3 ? 9 : 8.5;
        return doc.font(font).fontSize(size).heightOfString(seg.text, { width: maxW, lineGap: 1.5 }) + (seg.heading ? 4 : 2);
    }
    if (seg.kind === "bullet") {
        const text = seg.isCheckbox ? `☑  ${seg.text}` : seg.text;
        const w = seg.isCheckbox ? maxW : maxW - 14;
        return doc.font("Regular").fontSize(8.5).heightOfString(text, { width: w, lineGap: 1.5 }) + 2;
    }
    return 0;
}

/** Render a single segment at ctx.y. DOES NOT handle page breaks — caller does. */
function renderOneSeg(ctx: RenderCtx, seg: Segment): void {
    const { doc, x, maxW, images } = ctx;
    const IMG_MAX_W = maxW - 8;
    const IMG_MAX_H = 300;

    if (seg.kind === "br") {
        ctx.y += 4;
    } else if (seg.kind === "img") {
        const buf = images.get(seg.src);
        if (!buf) return;
        try {
            const imgObj = (doc as any).openImage(buf);
            const natW: number = imgObj.width ?? 400;
            const natH: number = imgObj.height ?? 300;
            const scale = Math.min(1, IMG_MAX_W / natW, IMG_MAX_H / natH);
            const rendW = Math.round(natW * scale);
            const rendH = Math.round(natH * scale);
            doc.image(buf, x + 4, ctx.y, { width: rendW, height: rendH });
            ctx.y += rendH + 8;
        } catch (e: any) { process.stderr.write(`[img render error]: ${e?.message}\n`); }
    } else if (seg.kind === "text") {
        const font = (seg.heading ?? 0) > 0 ? "Bold" : "Regular";
        const size = seg.heading === 1 ? 11 : seg.heading === 2 ? 9.5 : seg.heading === 3 ? 9 : 8.5;
        const h = doc.font(font).fontSize(size).heightOfString(seg.text, { width: maxW, lineGap: 1.5 });
        doc.font(font).fontSize(size).fillColor(C_TEXT).text(seg.text, x, ctx.y, { width: maxW, lineGap: 1.5 });
        ctx.y += h + (seg.heading ? 4 : 2);
    } else if (seg.kind === "bullet") {
        if (seg.isCheckbox) {
            const symbol = seg.checked ? "☑" : "☐";
            const color = seg.checked ? C_BADGE_TEXT : C_TEXT;
            const label = `${symbol}  ${seg.text}`;
            const h = doc.font("Regular").fontSize(8.5).heightOfString(label, { width: maxW, lineGap: 1.5 });
            doc.font("Regular").fontSize(8.5).fillColor(color).text(label, x, ctx.y, { width: maxW, lineGap: 1.5 });
            ctx.y += h + 2;
        } else {
            doc.font("Regular").fontSize(8.5).fillColor(C_TEXT).text("•", x, ctx.y, { width: 10 });
            const h = doc.font("Regular").fontSize(8.5).heightOfString(seg.text, { width: maxW - 14, lineGap: 1.5 });
            doc.font("Regular").fontSize(8.5).fillColor(C_TEXT).text(seg.text, x + 12, ctx.y, { width: maxW - 14, lineGap: 1.5 });
            ctx.y += h + 2;
        }
    }
}

/**
 * Render segments with automatic page breaks.
 * When y would exceed MAX_Y, a new page is created and rendering continues.
 */
function renderSegmentsPaged(ctx: RenderCtx, segs: Segment[]): void {
    for (const seg of segs) {
        const h = segHeight(ctx.doc, seg, ctx.maxW, ctx.images);
        // If this segment won't fit, start a new page
        if (ctx.y + h > MAX_Y && seg.kind !== "br") {
            ctx.y = newPage(ctx);
            // After page 1, content is full-width
            ctx.x = ML + 6;
            ctx.maxW = FULL_W - 12;
        }
        renderOneSeg(ctx, seg);
    }
}

// ── Core: render one work package into an existing doc/ctx ───────────────────

/**
 * Render a single work package (header, attributes, description, activities)
 * into the given doc. If ctx is provided, continues from that position
 * (adding a new page first). Otherwise starts the first page.
 * Returns the ctx after rendering (for chaining multiple WPs).
 */
function renderWorkPackage(
    doc: InstanceType<typeof PDFDocument>,
    data: WorkPackageData,
    existingCtx?: RenderCtx,
): RenderCtx {
    const images = data.images ?? new Map<string, Buffer>();
    const activities = data.activities || [];

    let ctx: RenderCtx;

    if (existingCtx) {
        // New WP in same document — finish previous page footer, start fresh page
        drawFooter(doc, existingCtx.data, existingCtx.pageNum);
        doc.addPage();
        const pageNum = existingCtx.pageNum + 1;
        drawHeader(doc, data);
        const attrBottom = drawAttrTable(doc, data, BODY_Y);
        ctx = { doc, data, images, x: ML + 6, maxW: FULL_W - 12, y: attrBottom + 8, pageNum };
    } else {
        // First WP — first page of document
        doc.addPage();
        drawHeader(doc, data);
        const attrBottom = drawAttrTable(doc, data, BODY_Y);
        ctx = { doc, data, images, x: ML + 6, maxW: FULL_W - 12, y: attrBottom + 8, pageNum: 1 };
    }

    // Description
    const descSegs = data.description ? parseHtml(data.description) : [];

    rect(doc, ML, ctx.y, FULL_W, 20, C_SECT_BG);
    doc.font("Bold").fontSize(8).fillColor(C_SECT_LABEL).text("DESCRIPTION", ML + 6, ctx.y + 6);
    hline(doc, ML, ML + FULL_W, ctx.y + 20, C_BORDER);
    ctx.y += 22;

    if (descSegs.length === 0) {
        doc.font("Regular").fontSize(8.5).fillColor(C_MUTED).text("(Không có mô tả)", ML + 6, ctx.y);
        ctx.y += 14;
    } else {
        renderSegmentsPaged(ctx, descSegs);
    }

    // Activities
    if (activities.length > 0) {
        if (ctx.y > MAX_Y - 60) {
            ctx.y = newPage(ctx);
        } else {
            ctx.y += 10;
        }
        ctx.x = ML + 6;
        ctx.maxW = FULL_W - 12;

        rect(doc, ML, ctx.y, FULL_W, 22, C_SECT_BG);
        doc.font("Bold").fontSize(9).fillColor(C_SECT_LABEL).text("ACTIVITY", ML + 8, ctx.y + 7);
        hline(doc, ML, PW - ML, ctx.y + 22, C_BORDER);
        ctx.y += 30;

        let actNum = 0;
        for (const act of activities) {
            actNum++;
            const headerH = 34;
            if (ctx.y + headerH > MAX_Y) {
                ctx.y = newPage(ctx);
                ctx.x = ML + 6;
                ctx.maxW = FULL_W - 12;
            }

            const boxX = ML;
            const boxW = FULL_W;

            const numStr = String(actNum);
            rect(doc, boxX, ctx.y, 22, 22, C_ACT_NUM_BG, 4);
            doc.font("Bold").fontSize(9).fillColor("#FFFFFF")
               .text(numStr, boxX + (22 - doc.widthOfString(numStr)) / 2, ctx.y + 7);

            doc.font("Bold").fontSize(8.5).fillColor(C_TEXT).text(act.author, boxX + 28, ctx.y + 4);
            doc.font("Regular").fontSize(7.5).fillColor(C_ACT_DATE).text(act.date, boxX + 28, ctx.y + 15);
            ctx.y += 28;

            if (act.details && act.details.length > 0) {
                for (const detail of act.details) {
                    if (ctx.y + 14 > MAX_Y) { ctx.y = newPage(ctx); ctx.x = ML + 6; ctx.maxW = FULL_W - 12; }
                    const h = doc.font("Regular").fontSize(8).heightOfString(detail, { width: boxW - 10, lineGap: 1.5 });
                    doc.font("Regular").fontSize(8).fillColor(C_MUTED).text(detail, boxX + 6, ctx.y, { width: boxW - 10, lineGap: 1.5 });
                    ctx.y += h + 2;
                }
            }

            if (act.comment && act.comment.trim()) {
                const actSegs = parseHtml(act.comment);
                rect(doc, boxX, ctx.y, 3, 4, C_HEADER_BG);
                ctx.y += 2;
                renderSegmentsPaged(ctx, actSegs);
                ctx.y += 4;
            }

            hline(doc, ML, PW - ML, ctx.y + 2, C_BORDER);
            ctx.y += 12;
        }
    }

    return ctx;
}

// ── Main exports ─────────────────────────────────────────────────────────────

export function generateWorkPackagePDF(data: WorkPackageData, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false });
        const stream = fs.createWriteStream(outputPath);
        doc.pipe(stream);
        doc.registerFont("Regular", FONT_REG);
        doc.registerFont("Bold", FONT_BOLD);

        const ctx = renderWorkPackage(doc, data);
        drawFooter(doc, ctx.data, ctx.pageNum);

        doc.end();
        stream.on("finish", resolve);
        stream.on("error", reject);
    });
}

export function generateCombinedPDF(allData: WorkPackageData[], outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false });
        const stream = fs.createWriteStream(outputPath);
        doc.pipe(stream);
        doc.registerFont("Regular", FONT_REG);
        doc.registerFont("Bold", FONT_BOLD);

        let ctx: RenderCtx | undefined;
        for (const data of allData) {
            ctx = renderWorkPackage(doc, data, ctx);
        }

        if (ctx) {
            drawFooter(doc, ctx.data, ctx.pageNum);
        }

        doc.end();
        stream.on("finish", resolve);
        stream.on("error", reject);
    });
}
