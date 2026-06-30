#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import process from "process";
import path from "path";
import os from "os";
import { generateWorkPackagePDF, generateCombinedPDF, WorkPackageData, ActivityData } from "./pdf-generator.js";

const BASE_URL = process.env.OPENPROJECT_URL!.replace(/\/$/, "");
const API_KEY  = process.env.OPENPROJECT_API_KEY!;

const _urlObj = new URL(BASE_URL);
const HOST_HEADER = process.env.OPENPROJECT_HOST_OVERRIDE || _urlObj.host;
const api = axios.create({
    baseURL: `${BASE_URL}/api/v3`,
    headers: {
        "Content-Type": "application/json",
        "Host": HOST_HEADER,
        "Authorization": `Bearer ${API_KEY}`,
    },
});

const server = new McpServer({ name: "openproject-mcp", version: "1.0.0" });

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Download all images referenced in content, return src→Buffer map */
async function fetchContentImages(contents: string[]): Promise<Map<string, Buffer>> {
    const images = new Map<string, Buffer>();
    const regex = /src="(\/api\/v3\/attachments\/[^"]+)"/g;
    const srcs = new Set<string>();

    for (const content of contents) {
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
            srcs.add(match[1]);
        }
    }

    await Promise.all([...srcs].map(async (src) => {
        try {
            // src = "/api/v3/attachments/:id/content"
            // api baseURL already includes /api/v3, so strip that prefix
            const path = src.replace(/^\/api\/v3/, "");
            const res = await api.get(path, {
                responseType: "arraybuffer",
                maxRedirects: 10,
                // Some OpenProject instances redirect to S3/storage
                // Pass auth on redirects
            });
            const buf = Buffer.from(res.data);
            if (buf.length > 0) {
                images.set(src, buf);
            }
        } catch (err: any) {
            // Surface the error so we can debug
            process.stderr.write(`[img download failed] ${src}: ${err?.message}\n`);
        }
    }));

    return images;
}

function parseISODuration(iso?: string): string {
    if (!iso) return "";
    if (iso === "PT0S") return "0h";
    const h = iso.match(/(\d+(?:\.\d+)?)H/);
    const m = iso.match(/(\d+(?:\.\d+)?)M/);
    if (h) return `${parseFloat(h[1])}h`;
    if (m) return `${parseFloat(m[1])}m`;
    return iso;
}

function fmtDate(d?: string): string {
    if (!d) return "";
    try {
        const dt = new Date(d);
        return dt.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
    } catch {
        return d;
    }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

server.tool("list_projects", "Lấy danh sách tất cả projects", {}, async () => {
    let allProjects: any[] = [];
    let page = 1;
    const pageSize = 100;
    while (true) {
        const res = await api.get("/projects", { params: { pageSize, offset: page } });
        const elements = res.data._embedded?.elements ?? [];
        allProjects = allProjects.concat(elements);
        const total = res.data.total ?? elements.length;
        if (allProjects.length >= total || elements.length === 0) break;
        page += pageSize;
    }
    const projects = allProjects.map((p: any) => ({
        id: p.id,
        identifier: p.identifier,
        name: p.name,
        description: p.description?.raw ?? "",
        status: p.status,
        active: p.active,
        public: p.public,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        parent: p._links?.parent?.title ?? null,
    }));
    return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
});

server.tool(
    "get_work_packages",
    "Lấy danh sách work packages của project",
    { project_id: z.string().describe("ID hoặc identifier của project") },
    async ({ project_id }) => {
        const params = { sortBy: JSON.stringify([["id", "desc"]]) };
        const res = await api.get(`/projects/${project_id}/work_packages`, { params });
        const elements = res.data._embedded?.elements ?? [];
        const summary = elements.map((wp: any) => ({
            id: wp.id,
            subject: wp.subject,
            type: wp._links?.type?.title,
            status: wp._links?.status?.title,
            priority: wp._links?.priority?.title,
            assignee: wp._links?.assignee?.title,
            accountable: wp._links?.responsible?.title,
            startDate: wp.startDate,
            dueDate: wp.dueDate,
            percentageDone: wp.percentageDone,
        }));
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    },
);

// Status IDs to exclude: Closed(4), Done(8), Resolved(3), Cancel(7), Reject(9)
const EXCLUDED_STATUS_IDS = ["4", "8", "3", "7", "9"];

server.tool(
    "get_work_packages_by_assignee",
    "Lấy danh sách work packages đang mở theo assignee (người được giao việc). Tự động loại trừ các status: Closed, Done, Resolved, Cancelled.",
    {
        assignee_id: z.number().describe("ID của user (assignee)"),
        project_id: z.string().optional().describe("ID project để lọc thêm (tuỳ chọn)"),
        sort_by_id: z.enum(["asc", "desc"]).optional().describe("Sắp xếp theo ID: 'asc' (tăng dần) hoặc 'desc' (giảm dần). Mặc định không sắp xếp theo ID."),
        limit: z.number().int().min(1).optional().describe("Giới hạn số lượng kết quả trả về. Mặc định 100."),
    },
    async ({ assignee_id, project_id, sort_by_id, limit }) => {
        const filters = JSON.stringify([
            { assignee: { operator: "=", values: [String(assignee_id)] } },
            { status: { operator: "!", values: EXCLUDED_STATUS_IDS } },
        ]);
        const endpoint = project_id
            ? `/projects/${project_id}/work_packages`
            : "/work_packages";
        const params: Record<string, any> = { filters, pageSize: limit ?? 100 };
        params.sortBy = JSON.stringify([["id", sort_by_id ?? "desc"]]);
        const res = await api.get(endpoint, { params });
        const elements = res.data._embedded?.elements ?? [];
        const summary = elements.map((wp: any) => ({
            id: wp.id,
            subject: wp.subject,
            type: wp._links?.type?.title,
            status: wp._links?.status?.title,
            priority: wp._links?.priority?.title,
            assignee: wp._links?.assignee?.title,
            accountable: wp._links?.responsible?.title,
            startDate: wp.startDate,
            dueDate: wp.dueDate,
            percentageDone: wp.percentageDone,
        }));
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    },
);

server.tool(
    "get_work_packages_by_accountable",
    "Lấy danh sách work packages đang mở theo accountable (người chịu trách nhiệm). Tự động loại trừ các status: Closed, Done, Resolved, Cancelled.",
    {
        accountable_id: z.number().describe("ID của user (accountable)"),
        project_id: z.string().optional().describe("ID project để lọc thêm (tuỳ chọn)"),
        sort_by_id: z.enum(["asc", "desc"]).optional().describe("Sắp xếp theo ID: 'asc' (tăng dần) hoặc 'desc' (giảm dần). Mặc định không sắp xếp theo ID."),
        limit: z.number().int().min(1).optional().describe("Giới hạn số lượng kết quả trả về. Mặc định 100."),
    },
    async ({ accountable_id, project_id, sort_by_id, limit }) => {
        const filters = JSON.stringify([
            { responsible: { operator: "=", values: [String(accountable_id)] } },
            { status: { operator: "!", values: EXCLUDED_STATUS_IDS } },
        ]);
        const endpoint = project_id
            ? `/projects/${project_id}/work_packages`
            : "/work_packages";
        const params: Record<string, any> = { filters, pageSize: limit ?? 100 };
        params.sortBy = JSON.stringify([["id", sort_by_id ?? "desc"]]);
        const res = await api.get(endpoint, { params });
        const elements = res.data._embedded?.elements ?? [];
        const summary = elements.map((wp: any) => ({
            id: wp.id,
            subject: wp.subject,
            type: wp._links?.type?.title,
            status: wp._links?.status?.title,
            priority: wp._links?.priority?.title,
            assignee: wp._links?.assignee?.title,
            accountable: wp._links?.responsible?.title,
            startDate: wp.startDate,
            dueDate: wp.dueDate,
            percentageDone: wp.percentageDone,
        }));
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    },
);

server.tool(
    "search_users",
    "Tìm kiếm user trong OpenProject theo tên (để lấy ID dùng cho filter)",
    { name: z.string().describe("Tên hoặc một phần tên user") },
    async ({ name }) => {
        const filters = JSON.stringify([{ name: { operator: "~", values: [name] } }]);
        const res = await api.get("/users", { params: { filters } });
        const users = (res.data._embedded?.elements ?? []).map((u: any) => ({
            id: u.id,
            name: u.name,
            login: u.login,
            email: u.email,
        }));
        return { content: [{ type: "text", text: JSON.stringify(users, null, 2) }] };
    },
);

server.tool(
    "get_work_package",
    "Lấy chi tiết một work package theo ID",
    { id: z.number().describe("ID của work package") },
    async ({ id }) => {
        const res = await api.get(`/work_packages/${id}`);
        const wp = res.data;
        const detail = {
            id: wp.id,
            subject: wp.subject,
            description: wp.description?.raw ?? "",
            type: wp._links?.type?.title,
            status: wp._links?.status?.title,
            priority: wp._links?.priority?.title,
            assignee: wp._links?.assignee?.title,
            accountable: wp._links?.responsible?.title,
            project: wp._links?.project?.title,
            parent: wp._links?.parent?.title ?? null,
            version: wp._links?.version?.title ?? null,
            category: wp._links?.category?.title ?? null,
            startDate: wp.startDate,
            dueDate: wp.dueDate,
            estimatedTime: parseISODuration(wp.estimatedTime),
            remainingTime: parseISODuration(wp.remainingTime),
            spentTime: parseISODuration(wp.spentTime),
            percentageDone: wp.percentageDone,
            createdAt: wp.createdAt,
            updatedAt: wp.updatedAt,
            lockVersion: wp.lockVersion,
        };
        return { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] };
    },
);

server.tool(
    "list_statuses",
    "Lấy danh sách tất cả trạng thái (status) có sẵn trong OpenProject",
    {},
    async () => {
        const res = await api.get("/statuses");
        const statuses = (res.data._embedded?.elements ?? []).map((s: any) => ({
            id: s.id,
            name: s.name,
            isClosed: s.isClosed,
            isDefault: s.isDefault,
        }));
        return { content: [{ type: "text", text: JSON.stringify(statuses, null, 2) }] };
    },
);

server.tool(
    "update_work_package_status",
    "Cập nhật trạng thái (status) của một work package",
    {
        work_package_id: z.number().describe("ID của work package"),
        status_id: z.number().describe("ID của status mới (dùng list_statuses để xem danh sách)"),
    },
    async ({ work_package_id, status_id }) => {
        // Lấy lockVersion hiện tại (bắt buộc cho optimistic locking)
        const wpRes = await api.get(`/work_packages/${work_package_id}`);
        const lockVersion: number = wpRes.data.lockVersion;
        const currentStatus: string = wpRes.data._links?.status?.title ?? "";

        const payload = {
            lockVersion,
            _links: {
                status: { href: `/api/v3/statuses/${status_id}` },
            },
        };
        const res = await api.patch(`/work_packages/${work_package_id}`, payload);
        const newStatus: string = res.data._links?.status?.title ?? "";

        return {
            content: [{
                type: "text",
                text: `✅ Đã cập nhật status work package #${work_package_id}\n` +
                      `   Trước: ${currentStatus}\n` +
                      `   Sau:   ${newStatus}`,
            }],
        };
    },
);

server.tool(
    "create_work_package",
    "Tạo work package mới trong project",
    {
        project_id: z.string().describe("ID của project"),
        subject: z.string().describe("Tiêu đề task"),
        description: z.string().optional().describe("Mô tả chi tiết"),
    },
    async ({ project_id, subject, description }) => {
        const payload: any = {
            subject,
            _links: { project: { href: `/api/v3/projects/${project_id}` } },
        };
        if (description) payload.description = { raw: description };
        const res = await api.post("/work_packages", payload);
        const created = res.data;
        const result = {
            id: created.id,
            subject: created.subject,
            type: created._links?.type?.title,
            status: created._links?.status?.title,
            project: created._links?.project?.title,
            createdAt: created.createdAt,
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
);

server.tool(
    "debug_work_package_content",
    "Debug: xem raw HTML content của work package để kiểm tra img tags",
    { work_package_id: z.number() },
    async ({ work_package_id }) => {
        const wpRes = await api.get(`/work_packages/${work_package_id}`);
        const wp = wpRes.data;
        const actRes = await api.get(`/work_packages/${work_package_id}/activities`);
        const acts = actRes.data._embedded?.elements ?? [];

        const descHtml = wp.description?.html ?? "(no html)";
        const descRaw  = wp.description?.raw  ?? "(no raw)";

        const actSummary = acts.slice(0, 3).map((a: any) => ({
            version: a.version,
            commentHtml: (a.comment?.html ?? "").slice(0, 300),
            commentRaw:  (a.comment?.raw  ?? "").slice(0, 300),
        }));

        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    descriptionHtml: descHtml.slice(0, 1000),
                    descriptionRaw: descRaw.slice(0, 500),
                    firstActivities: actSummary,
                }, null, 2),
            }],
        };
    },
);

// ── Helper: fetch full WP data ───────────────────────────────────────────────

async function fetchWorkPackageData(work_package_id: number): Promise<WorkPackageData> {
    const wpRes = await api.get(`/work_packages/${work_package_id}`);
    const wp = wpRes.data;

    const actRes = await api.get(`/work_packages/${work_package_id}/activities`);
    const rawActivities = actRes.data._embedded?.elements ?? [];

    let projectName = "";
    try {
        const projectHref: string = wp._links?.project?.href ?? "";
        if (projectHref) {
            const projRes = await api.get(projectHref.replace("/api/v3", ""));
            projectName = projRes.data.name ?? "";
        }
    } catch { /* ignore */ }

    const descriptionHtml = wp.description?.html ?? wp.description?.raw ?? "";

    const activities: ActivityData[] = rawActivities
        .filter((a: any) => a.comment?.raw || (a._embedded?.details?.length ?? 0) > 0)
        .map((a: any) => ({
            version: a.version ?? 1,
            date: fmtDate(a.createdAt),
            author: a._embedded?.user?.name ?? a._links?.user?.title ?? "",
            comment: a.comment?.html ?? a.comment?.raw ?? "",
            details: (a._embedded?.details ?? []).map(
                (d: any) => `${d.name}: ${d.raw ?? ""}`,
            ),
        }));

    const allContents = [
        descriptionHtml,
        ...activities.map(a => a.comment ?? ""),
    ];
    const images = await fetchContentImages(allContents);

    return {
        id: wp.id,
        subject: wp.subject,
        status: wp._links?.status?.title,
        assignee: wp._links?.assignee?.title,
        accountable: wp._links?.accountable?.title,
        estimatedTime: parseISODuration(wp.estimatedTime),
        remainingTime: parseISODuration(wp.remainingTime),
        percentageDone: wp.percentageDone ?? null,
        spentTime: parseISODuration(wp.spentTime),
        priority: wp._links?.priority?.title,
        startDate: fmtDate(wp.startDate),
        dueDate: fmtDate(wp.dueDate),
        category: wp._links?.category?.title,
        version: wp._links?.version?.title,
        description: descriptionHtml,
        projectName,
        images,
        activities,
    };
}

// ── Tool: generate single WP PDF ─────────────────────────────────────────────

server.tool(
    "generate_work_package_pdf",
    "Tải work package từ OpenProject và xuất file PDF theo mẫu. Trả về đường dẫn file PDF.",
    {
        work_package_id: z.number().describe("ID của work package"),
        output_path: z.string().optional().describe("Đường dẫn lưu file PDF (mặc định: thư mục temp)"),
    },
    async ({ work_package_id, output_path }) => {
        const data = await fetchWorkPackageData(work_package_id);

        const filePath = output_path
            ?? path.join(os.tmpdir(), `work_package_${work_package_id}.pdf`);

        await generateWorkPackagePDF(data, filePath);

        return {
            content: [{
                type: "text",
                text: `✅ PDF đã lưu tại: ${filePath}\n` +
                      `   Work package: #${data.id} - ${data.subject}\n` +
                      `   Activities: ${(data.activities || []).length} entries\n` +
                      `   Images embedded: ${(data.images || new Map()).size}`,
            }],
        };
    },
);

// ── Tool: generate combined PDF (parent + children) ──────────────────────────

server.tool(
    "generate_combined_pdf",
    "Tải work package và tất cả children, xuất thành 1 file PDF gộp. Trả về đường dẫn file PDF.",
    {
        work_package_id: z.number().describe("ID của work package gốc (parent)"),
        output_path: z.string().optional().describe("Đường dẫn lưu file PDF (mặc định: thư mục temp)"),
    },
    async ({ work_package_id, output_path }) => {
        // 1. Fetch parent WP to get children links
        const wpRes = await api.get(`/work_packages/${work_package_id}`);
        const childrenLinks: { href: string; title: string }[] = wpRes.data._links?.children ?? [];

        // 2. Extract child IDs
        const childIds = childrenLinks.map(c => {
            const match = c.href.match(/\/work_packages\/(\d+)/);
            return match ? parseInt(match[1], 10) : null;
        }).filter((id): id is number => id !== null);

        // 3. Fetch all WP data: parent first, then children
        const allIds = [work_package_id, ...childIds];
        const allData: WorkPackageData[] = [];

        for (const id of allIds) {
            try {
                const data = await fetchWorkPackageData(id);
                allData.push(data);
            } catch (err: any) {
                process.stderr.write(`[fetch WP #${id} failed] ${err?.message}\n`);
            }
        }

        if (allData.length === 0) {
            return { content: [{ type: "text", text: "❌ Không lấy được dữ liệu work package nào." }] };
        }

        // 4. Generate combined PDF
        const filePath = output_path
            ?? path.join(os.tmpdir(), `work_packages_combined_${work_package_id}.pdf`);

        await generateCombinedPDF(allData, filePath);

        const summary = allData.map(d => `  #${d.id} - ${d.subject}`).join("\n");
        return {
            content: [{
                type: "text",
                text: `✅ PDF gộp đã lưu tại: ${filePath}\n` +
                      `   Tổng: ${allData.length} work packages (1 parent + ${childIds.length} children)\n` +
                      summary,
            }],
        };
    },
);

// ── Tool: add comment to work package ────────────────────────────────────────

server.tool(
    "add_comment",
    "Thêm comment vào một work package",
    {
        work_package_id: z.number().describe("ID của work package"),
        comment: z.string().describe("Nội dung comment (hỗ trợ Markdown)"),
    },
    async ({ work_package_id, comment }) => {
        const res = await api.post(`/work_packages/${work_package_id}/activities`, {
            comment: { raw: comment },
        });
        const author = res.data._embedded?.user?.name ?? res.data._links?.user?.title ?? "Unknown";
        const version = res.data.version ?? "";
        return {
            content: [{
                type: "text",
                text: `✅ Đã thêm comment vào work package #${work_package_id}\n` +
                      `   Activity #${version} bởi ${author}`,
            }],
        };
    },
);

// ── Tool: get comments of a work package ────────────────────────────────────────

server.tool(
    "get_comments",
    "Lấy danh sách comment của một work package. Chỉ trả về các activity có comment (bỏ qua các thay đổi trạng thái thuần túy).",
    {
        work_package_id: z.number().describe("ID của work package"),
    },
    async ({ work_package_id }) => {
        const actRes = await api.get(`/work_packages/${work_package_id}/activities`);
        const rawActivities = actRes.data._embedded?.elements ?? [];

        const comments = rawActivities
            .filter((a: any) => a.comment?.raw && a.comment.raw.trim() !== "")
            .map((a: any) => ({
                id: a.id,
                version: a.version ?? 1,
                date: a.createdAt,
                author: a._embedded?.user?.name ?? a._links?.user?.title ?? "Unknown",
                comment: a.comment?.raw ?? "",
            }));

        if (comments.length === 0) {
            return {
                content: [{
                    type: "text",
                    text: `ℹ️ Work package #${work_package_id} không có comment nào.`,
                }],
            };
        }

        const lines = comments.map((c: any) =>
            `[${fmtDate(c.date)}] ${c.author} (activity #${c.version}):\n${c.comment}`
        );

        return {
            content: [{
                type: "text",
                text: `📝 ${comments.length} comment trong WP #${work_package_id}:\n\n${lines.join("\n\n---\n\n")}`,
            }],
        };
    },
);

// ── Tool: create relation between work packages ───────────────────────────────

const RELATION_TYPES = ["relates", "duplicates", "duplicated", "blocks", "blocked", "precedes", "follows", "includes", "partof", "requires", "required"] as const;

server.tool(
    "create_relation",
    "Tạo liên kết (relation) giữa hai work packages. Loại quan hệ mặc định là 'relates'.",
    {
        from_id: z.number().describe("ID của work package nguồn"),
        to_id: z.number().describe("ID của work package đích"),
        relation_type: z.enum(RELATION_TYPES).default("relates").describe(
            "Loại quan hệ: relates | duplicates | duplicated | blocks | blocked | precedes | follows | includes | partof | requires | required"
        ),
    },
    async ({ from_id, to_id, relation_type }) => {
        const payload = {
            _links: {
                from: { href: `/api/v3/work_packages/${from_id}` },
                to:   { href: `/api/v3/work_packages/${to_id}` },
            },
            type: relation_type,
        };
        const res = await api.post(`/work_packages/${from_id}/relations`, payload);
        return {
            content: [{
                type: "text",
                text: `✅ Đã tạo relation [${relation_type}] giữa WP #${from_id} → WP #${to_id}\n` +
                      `   Relation ID: ${res.data.id}`,
            }],
        };
    },
);

// ── Tool: auto-link work packages mentioned in content ────────────────────────

/** Extract WP IDs from HTML/raw content via various link patterns */
function extractMentionedWpIds(content: string, baseUrl: string): Set<number> {
    const ids = new Set<number>();

    // Pattern 1: full URL  e.g. https://op.example.com/work_packages/123
    const fullUrlRe = new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:projects/[^/]+/)?work_packages/(\\d+)`, "g");
    for (const m of content.matchAll(fullUrlRe)) ids.add(parseInt(m[1], 10));

    // Pattern 2: relative path  /work_packages/123  or  /projects/foo/work_packages/123
    const relPathRe = /\/(?:projects\/[^/\s"]+\/)?work_packages\/(\d+)/g;
    for (const m of content.matchAll(relPathRe)) ids.add(parseInt(m[1], 10));

    // Pattern 3: hash mention  #123  (common in OpenProject descriptions)
    const hashRe = /#(\d+)/g;
    for (const m of content.matchAll(hashRe)) ids.add(parseInt(m[1], 10));

    return ids;
}

server.tool(
    "auto_link_work_packages",
    "Quét nội dung (description + comments) của một work package, tìm các WP khác được nhắc tới nhưng chưa có relation, rồi tự động tạo relation 'relates'.",
    {
        work_package_id: z.number().describe("ID của work package cần kiểm tra"),
        dry_run: z.boolean().default(false).describe("Nếu true, chỉ báo cáo mà không tạo relation"),
    },
    async ({ work_package_id, dry_run }) => {
        // 1. Lấy nội dung WP
        const wpRes = await api.get(`/work_packages/${work_package_id}`);
        const wp = wpRes.data;
        const descHtml = wp.description?.html ?? wp.description?.raw ?? "";
        const descRaw  = wp.description?.raw ?? "";

        const actRes = await api.get(`/work_packages/${work_package_id}/activities`);
        const acts: any[] = actRes.data._embedded?.elements ?? [];
        const actContents = acts.map((a: any) => (a.comment?.html ?? "") + " " + (a.comment?.raw ?? ""));

        const allContent = [descHtml, descRaw, ...actContents].join(" ");

        // 2. Tìm các WP ID được nhắc tới
        const mentioned = extractMentionedWpIds(allContent, BASE_URL);
        mentioned.delete(work_package_id); // loại chính nó

        if (mentioned.size === 0) {
            return { content: [{ type: "text", text: "ℹ️ Không tìm thấy work package nào được nhắc tới trong nội dung." }] };
        }

        // 3. Lấy danh sách relation hiện tại
        const relRes = await api.get(`/work_packages/${work_package_id}/relations`);
        const existingRelations: any[] = relRes.data._embedded?.elements ?? [];
        const linkedIds = new Set<number>();
        for (const rel of existingRelations) {
            const fromHref: string = rel._links?.from?.href ?? "";
            const toHref:   string = rel._links?.to?.href   ?? "";
            const mFrom = fromHref.match(/\/work_packages\/(\d+)/);
            const mTo   = toHref.match(/\/work_packages\/(\d+)/);
            if (mFrom) linkedIds.add(parseInt(mFrom[1], 10));
            if (mTo)   linkedIds.add(parseInt(mTo[1],   10));
        }

        // 4. Tìm WP chưa được link
        const toLink = [...mentioned].filter(id => !linkedIds.has(id));

        if (toLink.length === 0) {
            return {
                content: [{
                    type: "text",
                    text: `ℹ️ Tất cả ${mentioned.size} work package được nhắc tới đã có relation.\n` +
                          `   Mentioned: ${[...mentioned].join(", ")}`,
                }],
            };
        }

        if (dry_run) {
            return {
                content: [{
                    type: "text",
                    text: `[Dry run] Sẽ tạo relation 'relates' từ WP #${work_package_id} đến:\n` +
                          toLink.map(id => `  → #${id}`).join("\n"),
                }],
            };
        }

        // 5. Tạo relation cho từng WP chưa có
        const results: string[] = [];
        for (const targetId of toLink) {
            try {
                const payload = {
                    _links: {
                        from: { href: `/api/v3/work_packages/${work_package_id}` },
                        to:   { href: `/api/v3/work_packages/${targetId}` },
                    },
                    type: "relates",
                };
                await api.post(`/work_packages/${work_package_id}/relations`, payload);
                results.push(`  ✅ Đã tạo relation → #${targetId}`);
            } catch (err: any) {
                results.push(`  ❌ Lỗi khi tạo relation → #${targetId}: ${err?.message}`);
            }
        }

        return {
            content: [{
                type: "text",
                text: `Kết quả auto-link cho WP #${work_package_id}:\n` + results.join("\n"),
            }],
        };
    },
);

// ── Tool: update work package ────────────────────────────────────────────────

server.tool(
    "update_work_package",
    "Cập nhật các trường của một work package: tiêu đề, mô tả, assignee, accountable, ngày bắt đầu/kết thúc, ước tính giờ, % hoàn thành, status, type, priority, version, category.",
    {
        work_package_id: z.number().describe("ID của work package"),
        subject: z.string().optional().describe("Tiêu đề mới"),
        description: z.string().optional().describe("Mô tả mới (Markdown)"),
        assignee_id: z.number().optional().describe("ID user được giao việc (0 = bỏ assignee)"),
        accountable_id: z.number().optional().describe("ID user chịu trách nhiệm (0 = bỏ accountable)"),
        start_date: z.string().optional().describe("Ngày bắt đầu (YYYY-MM-DD)"),
        due_date: z.string().optional().describe("Ngày kết thúc (YYYY-MM-DD)"),
        estimated_hours: z.number().optional().describe("Số giờ ước tính"),
        percentage_done: z.number().int().min(0).max(100).optional().describe("% hoàn thành (0-100)"),
        status_id: z.number().optional().describe("ID status mới"),
        type_id: z.number().optional().describe("ID type mới"),
        priority_id: z.number().optional().describe("ID priority mới"),
        version_id: z.number().optional().describe("ID version/sprint (0 = bỏ version)"),
        category_id: z.number().optional().describe("ID category (0 = bỏ category)"),
    },
    async ({ work_package_id, subject, description, assignee_id, accountable_id,
             start_date, due_date, estimated_hours, percentage_done,
             status_id, type_id, priority_id, version_id, category_id }) => {
        const wpRes = await api.get(`/work_packages/${work_package_id}`);
        const lockVersion: number = wpRes.data.lockVersion;

        const payload: any = { lockVersion };
        const links: any = {};

        if (subject !== undefined) payload.subject = subject;
        if (description !== undefined) payload.description = { raw: description };
        if (start_date !== undefined) payload.startDate = start_date;
        if (due_date !== undefined) payload.dueDate = due_date;
        if (estimated_hours !== undefined) {
            payload.estimatedTime = estimated_hours === 0 ? null : `PT${estimated_hours}H`;
        }
        if (percentage_done !== undefined) payload.percentageDone = percentage_done;

        if (assignee_id !== undefined)
            links.assignee = assignee_id === 0 ? { href: null } : { href: `/api/v3/users/${assignee_id}` };
        if (accountable_id !== undefined)
            links.responsible = accountable_id === 0 ? { href: null } : { href: `/api/v3/users/${accountable_id}` };
        if (status_id !== undefined)
            links.status = { href: `/api/v3/statuses/${status_id}` };
        if (type_id !== undefined)
            links.type = { href: `/api/v3/types/${type_id}` };
        if (priority_id !== undefined)
            links.priority = { href: `/api/v3/priorities/${priority_id}` };
        if (version_id !== undefined)
            links.version = version_id === 0 ? { href: null } : { href: `/api/v3/versions/${version_id}` };
        if (category_id !== undefined)
            links.category = category_id === 0 ? { href: null } : { href: `/api/v3/categories/${category_id}` };

        if (Object.keys(links).length > 0) payload._links = links;

        const res = await api.patch(`/work_packages/${work_package_id}`, payload);
        const updated = res.data;

        return {
            content: [{
                type: "text",
                text: `✅ Đã cập nhật work package #${work_package_id}\n` +
                      `   Tiêu đề: ${updated.subject}\n` +
                      `   Status: ${updated._links?.status?.title ?? "-"}\n` +
                      `   Assignee: ${updated._links?.assignee?.title ?? "-"}\n` +
                      `   Accountable: ${updated._links?.responsible?.title ?? "-"}\n` +
                      `   Ngày: ${updated.startDate ?? "-"} → ${updated.dueDate ?? "-"}\n` +
                      `   Hoàn thành: ${updated.percentageDone ?? 0}%`,
            }],
        };
    },
);

// ── Tool: search work packages ───────────────────────────────────────────────

server.tool(
    "search_work_packages",
    "Tìm kiếm work packages với nhiều bộ lọc: từ khóa, status, type, priority, assignee, project, parent, version, khoảng ngày.",
    {
        keyword: z.string().optional().describe("Từ khóa tìm trong tiêu đề/mô tả"),
        project_id: z.string().optional().describe("Giới hạn trong project (ID hoặc identifier)"),
        assignee_id: z.number().optional().describe("ID assignee"),
        accountable_id: z.number().optional().describe("ID accountable"),
        status_ids: z.array(z.number()).optional().describe("Danh sách ID status cần lọc"),
        exclude_status_ids: z.array(z.number()).optional().describe("Danh sách ID status cần loại trừ"),
        type_id: z.number().optional().describe("ID type (Task/Bug/Feature…)"),
        priority_id: z.number().optional().describe("ID priority"),
        version_id: z.number().optional().describe("ID version/sprint"),
        parent_id: z.number().optional().describe("Chỉ lấy WP con trực tiếp của WP này"),
        due_date_from: z.string().optional().describe("Due date từ ngày (YYYY-MM-DD)"),
        due_date_to: z.string().optional().describe("Due date đến ngày (YYYY-MM-DD)"),
        updated_from: z.string().optional().describe("Chỉ lấy WP có lần cập nhật cuối (updatedAt) từ ngày này (YYYY-MM-DD, theo giờ UTC)"),
        updated_to: z.string().optional().describe("Chỉ lấy WP có lần cập nhật cuối (updatedAt) đến HẾT ngày này, bao gồm cả ngày đó (YYYY-MM-DD, theo giờ UTC) — đây là ngày bao gồm (inclusive), không cần cộng thêm 1 ngày"),
        only_open: z.boolean().optional().describe("Chỉ lấy WP chưa đóng (loại Closed/Done/Resolved/Cancelled/Reject)"),
        sort_by: z.enum(["id", "subject", "status", "priority", "dueDate", "createdAt", "updatedAt"]).optional().describe("Trường sắp xếp"),
        sort_dir: z.enum(["asc", "desc"]).optional().default("desc").describe("Chiều sắp xếp"),
        limit: z.number().int().min(1).optional().describe("Số kết quả tối đa (mặc định 50)"),
        offset: z.number().int().nonnegative().optional().describe("Bỏ qua N kết quả đầu (phân trang)"),
    },
    async ({ keyword, project_id, assignee_id, accountable_id, status_ids, exclude_status_ids,
             type_id, priority_id, version_id, parent_id, due_date_from, due_date_to,
             updated_from, updated_to, only_open, sort_by, sort_dir, limit, offset }) => {
        const filters: any[] = [];

        function addOneDay(dateStr: string): string {
            const d = new Date(dateStr + "T00:00:00Z");
            d.setUTCDate(d.getUTCDate() + 1);
            return d.toISOString().split("T")[0];
        }

        if (keyword) filters.push({ subjectOrId: { operator: "**", values: [keyword] } });
        if (assignee_id) filters.push({ assignee: { operator: "=", values: [String(assignee_id)] } });
        if (accountable_id) filters.push({ responsible: { operator: "=", values: [String(accountable_id)] } });
        if (status_ids?.length) filters.push({ status: { operator: "=", values: status_ids.map(String) } });
        if (exclude_status_ids?.length) filters.push({ status: { operator: "!", values: exclude_status_ids.map(String) } });
        if (only_open) filters.push({ status: { operator: "!", values: EXCLUDED_STATUS_IDS } });
        if (type_id) filters.push({ type: { operator: "=", values: [String(type_id)] } });
        if (priority_id) filters.push({ priority: { operator: "=", values: [String(priority_id)] } });
        if (version_id) filters.push({ version: { operator: "=", values: [String(version_id)] } });
        if (parent_id) filters.push({ parent: { operator: "=", values: [String(parent_id)] } });
        if (due_date_from || due_date_to) {
            filters.push({ dueDate: { operator: "<>d", values: [due_date_from ?? "", due_date_to ?? ""] } });
        }
        if (updated_from || updated_to) {
            // OpenProject's <>d operator treats the "to" bound as exclusive, so we add
            // one day to updated_to here to make this parameter inclusive for callers.
            filters.push({ updatedAt: { operator: "<>d", values: [updated_from ?? "", updated_to ? addOneDay(updated_to) : ""] } });
        }

        const endpoint = project_id ? `/projects/${project_id}/work_packages` : "/work_packages";
        const params: Record<string, any> = {
            pageSize: limit ?? 50,
            offset: offset !== undefined ? offset + 1 : 1, // OpenProject uses 1-based offset
        };
        if (filters.length > 0) params.filters = JSON.stringify(filters);
        params.sortBy = JSON.stringify([[sort_by ?? "id", sort_dir ?? "desc"]]);

        const res = await api.get(endpoint, { params });
        const elements = res.data._embedded?.elements ?? [];
        const total: number = res.data.total ?? elements.length;

        const summary = elements.map((wp: any) => ({
            id: wp.id,
            subject: wp.subject,
            type: wp._links?.type?.title,
            status: wp._links?.status?.title,
            priority: wp._links?.priority?.title,
            assignee: wp._links?.assignee?.title,
            accountable: wp._links?.responsible?.title,
            startDate: wp.startDate,
            dueDate: wp.dueDate,
            percentageDone: wp.percentageDone,
        }));

        return {
            content: [{
                type: "text",
                text: `🔍 Tìm thấy ${total} kết quả (hiển thị ${elements.length}):\n\n` +
                      JSON.stringify(summary, null, 2),
            }],
        };
    },
);

// ── Tool: get project details ────────────────────────────────────────────────

server.tool(
    "get_project",
    "Lấy thông tin chi tiết của một project theo ID hoặc identifier",
    { project_id: z.string().describe("ID hoặc identifier của project") },
    async ({ project_id }) => {
        const res = await api.get(`/projects/${project_id}`);
        const p = res.data;
        const info = {
            id: p.id,
            identifier: p.identifier,
            name: p.name,
            description: p.description?.raw ?? "",
            status: p.status,
            active: p.active,
            public: p.public,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            parent: p._links?.parent?.title ?? null,
        };
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    },
);

// ── Tool: list types ─────────────────────────────────────────────────────────

server.tool(
    "list_types",
    "Lấy danh sách loại work package (Task, Bug, Feature, Milestone…). Có thể lọc theo project.",
    { project_id: z.string().optional().describe("ID project để lấy types trong project đó (tuỳ chọn)") },
    async ({ project_id }) => {
        const endpoint = project_id ? `/projects/${project_id}/types` : "/types";
        const res = await api.get(endpoint);
        const types = (res.data._embedded?.elements ?? []).map((t: any) => ({
            id: t.id,
            name: t.name,
            color: t.color,
            isDefault: t.isDefault,
            isMilestone: t.isMilestone,
        }));
        return { content: [{ type: "text", text: JSON.stringify(types, null, 2) }] };
    },
);

// ── Tool: get work package relations ────────────────────────────────────────

server.tool(
    "get_work_package_relations",
    "Lấy danh sách tất cả relations (liên kết) của một work package",
    { work_package_id: z.number().describe("ID của work package") },
    async ({ work_package_id }) => {
        const res = await api.get(`/work_packages/${work_package_id}/relations`);
        const elements = res.data._embedded?.elements ?? [];

        if (elements.length === 0) {
            return { content: [{ type: "text", text: `ℹ️ Work package #${work_package_id} không có relation nào.` }] };
        }

        const relations = elements.map((r: any) => {
            const fromHref: string = r._links?.from?.href ?? "";
            const toHref: string = r._links?.to?.href ?? "";
            const fromId = fromHref.match(/\/work_packages\/(\d+)/)?.[1];
            const toId = toHref.match(/\/work_packages\/(\d+)/)?.[1];
            return {
                id: r.id,
                type: r.type,
                from: { id: fromId ? parseInt(fromId) : null, title: r._links?.from?.title },
                to: { id: toId ? parseInt(toId) : null, title: r._links?.to?.title },
                description: r.description ?? null,
            };
        });

        return { content: [{ type: "text", text: JSON.stringify(relations, null, 2) }] };
    },
);

// ── Tool: delete relation ────────────────────────────────────────────────────

server.tool(
    "delete_relation",
    "Xóa một relation (liên kết) giữa hai work packages theo relation ID",
    { relation_id: z.number().describe("ID của relation cần xóa (lấy từ get_work_package_relations)") },
    async ({ relation_id }) => {
        await api.delete(`/relations/${relation_id}`);
        return {
            content: [{
                type: "text",
                text: `✅ Đã xóa relation #${relation_id}`,
            }],
        };
    },
);

// ── Tool: list attachments ───────────────────────────────────────────────────

server.tool(
    "list_attachments",
    "Lấy danh sách file đính kèm của một work package",
    { work_package_id: z.number().describe("ID của work package") },
    async ({ work_package_id }) => {
        const res = await api.get(`/work_packages/${work_package_id}/attachments`);
        const elements = res.data._embedded?.elements ?? [];

        if (elements.length === 0) {
            return { content: [{ type: "text", text: `ℹ️ Work package #${work_package_id} không có file đính kèm.` }] };
        }

        const attachments = elements.map((a: any) => ({
            id: a.id,
            fileName: a.fileName,
            fileSize: a.fileSize,
            contentType: a.contentType,
            createdAt: a.createdAt,
            author: a._embedded?.author?.name ?? a._links?.author?.title ?? "Unknown",
            downloadUrl: `${BASE_URL}${a._links?.downloadLocation?.href ?? ""}`,
        }));

        return { content: [{ type: "text", text: JSON.stringify(attachments, null, 2) }] };
    },
);

// ── Tool: upload attachment ──────────────────────────────────────────────────

server.tool(
    "upload_attachment",
    "Upload file đính kèm vào một work package từ đường dẫn file local",
    {
        work_package_id: z.number().describe("ID của work package"),
        file_path: z.string().describe("Đường dẫn tuyệt đối tới file cần upload"),
        file_name: z.string().optional().describe("Tên file hiển thị (mặc định: tên file gốc)"),
    },
    async ({ work_package_id, file_path, file_name }) => {
        const fs = await import("fs");
        const nodePath = await import("path");

        if (!fs.existsSync(file_path)) {
            return { content: [{ type: "text", text: `❌ File không tồn tại: ${file_path}` }] };
        }

        const displayName = file_name ?? nodePath.basename(file_path);
        const fileBuffer = fs.readFileSync(file_path);
        const stat = fs.statSync(file_path);

        // Step 1: Prepare upload (get presigned URL / metadata)
        const prepareRes = await api.post(
            `/work_packages/${work_package_id}/attachments`,
            {
                fileName: displayName,
                fileSize: stat.size,
                contentType: "application/octet-stream",
                description: { raw: "" },
            },
            { headers: { "Content-Type": "application/json" } },
        );

        // If direct upload URL is provided (some OpenProject versions use chunked upload)
        const uploadUrl: string | undefined = prepareRes.data._links?.uploadUrl?.href;

        if (uploadUrl) {
            // Upload binary to the presigned URL
            const absoluteUploadUrl = uploadUrl.startsWith("http") ? uploadUrl : `${BASE_URL}${uploadUrl}`;
            await axios.put(absoluteUploadUrl, fileBuffer, {
                headers: { "Content-Type": "application/octet-stream" },
                maxBodyLength: Infinity,
            });

            // Finish upload
            const finishHref: string | undefined = prepareRes.data._links?.finishUpload?.href;
            if (finishHref) {
                const absoluteFinishUrl = finishHref.startsWith("http") ? finishHref : `${BASE_URL}${finishHref}`;
                await axios.post(absoluteFinishUrl, {}, {
                    headers: { "Authorization": `Bearer ${API_KEY}` },
                });
            }
        }

        const attachmentId = prepareRes.data.id;
        const savedName = prepareRes.data.fileName ?? displayName;

        return {
            content: [{
                type: "text",
                text: `✅ Đã upload file vào work package #${work_package_id}\n` +
                      `   Attachment ID: ${attachmentId}\n` +
                      `   Tên file: ${savedName}\n` +
                      `   Kích thước: ${(stat.size / 1024).toFixed(1)} KB`,
            }],
        };
    },
);

// ── Tool: get work package children ─────────────────────────────────────────

server.tool(
    "get_work_package_children",
    "Lấy danh sách work package con (children) của một work package",
    {
        work_package_id: z.number().describe("ID của work package cha"),
        include_closed: z.boolean().optional().describe("Bao gồm cả WP đã đóng (mặc định: false)"),
    },
    async ({ work_package_id, include_closed }) => {
        const wpRes = await api.get(`/work_packages/${work_package_id}`);
        const childrenLinks: { href: string; title: string }[] = wpRes.data._links?.children ?? [];

        if (childrenLinks.length === 0) {
            return {
                content: [{
                    type: "text",
                    text: `ℹ️ Work package #${work_package_id} không có WP con nào.`,
                }],
            };
        }

        const childIds = childrenLinks.map(c => {
            const match = c.href.match(/\/work_packages\/(\d+)/);
            return match ? parseInt(match[1], 10) : null;
        }).filter((id): id is number => id !== null);

        // Fetch details for each child
        const children = await Promise.all(
            childIds.map(async id => {
                try {
                    const res = await api.get(`/work_packages/${id}`);
                    const wp = res.data;
                    return {
                        id: wp.id,
                        subject: wp.subject,
                        type: wp._links?.type?.title,
                        status: wp._links?.status?.title,
                        assignee: wp._links?.assignee?.title,
                        percentageDone: wp.percentageDone,
                        startDate: wp.startDate,
                        dueDate: wp.dueDate,
                    };
                } catch {
                    return { id, error: "Không thể tải" };
                }
            }),
        );

        const filtered = include_closed
            ? children
            : children.filter((c: any) => !c.error && !EXCLUDED_STATUS_IDS.includes(String((c as any).statusId)));

        return {
            content: [{
                type: "text",
                text: `📋 ${children.length} WP con của #${work_package_id}:\n\n` +
                      JSON.stringify(filtered, null, 2),
            }],
        };
    },
);

// ── Tool: get notifications ──────────────────────────────────────────────────

const NOTIFICATION_REASON_LABELS: Record<string, string> = {
    mentioned:             "Được nhắc tên (@mention)",
    assigned:              "Được giao việc (Assignee)",
    responsible:           "Chịu trách nhiệm (Accountable)",
    watched:               "Đang theo dõi (Watched)",
    commented:             "Có bình luận mới",
    created:               "Work package mới tạo",
    date_alert_due_date:   "Cảnh báo đến hạn (Due date)",
    date_alert_start_date: "Cảnh báo ngày bắt đầu (Start date)",
    shared:                "Được chia sẻ",
    prioritized:           "Được ưu tiên",
    work_package_updated:  "Work package được cập nhật",
};

server.tool(
    "get_notifications",
    "Lấy danh sách thông báo (notifications) của người dùng hiện tại trong OpenProject. Phân loại rõ theo lý do: mention, assigned, commented, date alert, v.v.",
    {
        unread_only: z.boolean().optional().describe("Chỉ lấy thông báo chưa đọc (mặc định: true)"),
        limit: z.number().int().min(1).optional().describe("Số thông báo tối đa (mặc định: 50)"),
        group_by_reason: z.boolean().optional().describe("Nhóm kết quả theo loại thông báo (mặc định: true)"),
    },
    async ({ unread_only = true, limit = 50, group_by_reason = true }) => {
        const filters: any[] = [];
        if (unread_only) {
            filters.push({ readIAN: { operator: "=", values: ["f"] } });
        }

        const params: Record<string, any> = { pageSize: limit };
        if (filters.length > 0) params.filters = JSON.stringify(filters);

        const res = await api.get("/notifications", { params });
        const elements: any[] = res.data._embedded?.elements ?? [];
        const total: number = res.data.total ?? elements.length;

        if (elements.length === 0) {
            return {
                content: [{
                    type: "text",
                    text: unread_only
                        ? "✅ Không có thông báo chưa đọc."
                        : "ℹ️ Không có thông báo nào.",
                }],
            };
        }

        // Map từng notification thành object gọn
        const notifications = elements.map((n: any) => {
            const reason: string = n.reason ?? "unknown";
            const wp = n._embedded?.resource ?? {};
            const project = n._embedded?.project ?? {};
            return {
                id: n.id,
                reason,
                reasonLabel: NOTIFICATION_REASON_LABELS[reason] ?? reason,
                readIAN: n.readIAN ?? false,
                createdAt: fmtDate(n.createdAt),
                actor: n._embedded?.actor?.name ?? n._links?.actor?.title ?? null,
                workPackage: wp.id ? {
                    id: wp.id,
                    subject: wp.subject ?? n._links?.resource?.title,
                    status: wp._links?.status?.title ?? null,
                } : null,
                project: project.name ?? n._links?.project?.title ?? null,
                details: n.message ?? n._embedded?.details?.text ?? null,
            };
        });

        if (!group_by_reason) {
            const lines = notifications.map(n =>
                `[${n.reasonLabel}] #${n.workPackage?.id ?? "-"} ${n.workPackage?.subject ?? ""}\n` +
                `  Project: ${n.project ?? "-"} | Từ: ${n.actor ?? "-"} | ${n.createdAt}`
            );
            return {
                content: [{
                    type: "text",
                    text: `🔔 ${total} thông báo${unread_only ? " chưa đọc" : ""}:\n\n` + lines.join("\n\n"),
                }],
            };
        }

        // Nhóm theo reason
        const groups = new Map<string, typeof notifications>();
        for (const n of notifications) {
            const key = n.reasonLabel;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(n);
        }

        const sections: string[] = [];
        for (const [label, items] of groups) {
            const lines = items.map(n =>
                `  • WP #${n.workPackage?.id ?? "-"} — ${n.workPackage?.subject ?? "(không rõ)"}\n` +
                `    Project: ${n.project ?? "-"} | Từ: ${n.actor ?? "-"} | ${n.createdAt}`
            );
            sections.push(`📌 ${label} (${items.length}):\n${lines.join("\n")}`);
        }

        return {
            content: [{
                type: "text",
                text: `🔔 ${total} thông báo${unread_only ? " chưa đọc" : ""} — ${groups.size} loại:\n\n` +
                      sections.join("\n\n"),
            }],
        };
    },
);

server.tool(
    "mark_notifications_read",
    "Đánh dấu đã đọc các thông báo theo ID, hoặc đánh dấu tất cả là đã đọc.",
    {
        notification_ids: z.array(z.number()).optional().describe("Danh sách ID thông báo cần đánh dấu đã đọc. Nếu bỏ trống → đánh dấu TẤT CẢ đã đọc."),
    },
    async ({ notification_ids }) => {
        if (!notification_ids || notification_ids.length === 0) {
            // Đánh dấu tất cả đã đọc
            await api.post("/notifications/read_ian", {});
            return {
                content: [{
                    type: "text",
                    text: "✅ Đã đánh dấu tất cả thông báo là đã đọc.",
                }],
            };
        }

        // Đánh dấu từng notification
        const results: string[] = [];
        for (const id of notification_ids) {
            try {
                await api.post(`/notifications/${id}/read_ian`, {});
                results.push(`  ✅ #${id}`);
            } catch (err: any) {
                results.push(`  ❌ #${id}: ${err?.message}`);
            }
        }

        return {
            content: [{
                type: "text",
                text: `Kết quả đánh dấu đã đọc:\n${results.join("\n")}`,
            }],
        };
    },
);

// ── Tool: set work package parent ────────────────────────────────────────────

server.tool(
    "set_work_package_parent",
    "Đặt hoặc xóa parent của một work package. Truyền parent_id = 0 để xóa parent (chuyển thành WP gốc).",
    {
        work_package_id: z.number().describe("ID của work package cần đặt parent"),
        parent_id: z.number().describe("ID của work package cha mới. Truyền 0 để xóa parent"),
    },
    async ({ work_package_id, parent_id }) => {
        const wpRes = await api.get(`/work_packages/${work_package_id}`);
        const lockVersion: number = wpRes.data.lockVersion;
        const currentParent = wpRes.data._links?.parent?.title ?? null;

        const parentLink = parent_id === 0
            ? { href: null }
            : { href: `/api/v3/work_packages/${parent_id}` };

        const payload = {
            lockVersion,
            _links: { parent: parentLink },
        };

        const res = await api.patch(`/work_packages/${work_package_id}`, payload);
        const updated = res.data;
        const newParent = updated._links?.parent?.title ?? null;

        const action = parent_id === 0
            ? `Đã xóa parent (trước đây: ${currentParent ?? "-"})`
            : `Đã đặt parent thành #${parent_id} "${newParent ?? "-"}"`;

        return {
            content: [{
                type: "text",
                text: `✅ Work package #${work_package_id} — ${action}\n` +
                      `   Tiêu đề: ${updated.subject}\n` +
                      `   Parent mới: ${newParent ?? "(không có)"}`,
            }],
        };
    },
);

// ── Tool: add work package child ─────────────────────────────────────────────

server.tool(
    "add_work_package_child",
    "Thêm một work package làm con (child) của work package hiện tại bằng cách đặt parent của WP con thành WP hiện tại.",
    {
        parent_id: z.number().describe("ID của work package cha"),
        child_id: z.number().describe("ID của work package sẽ trở thành con"),
    },
    async ({ parent_id, child_id }) => {
        // Verify parent exists
        await api.get(`/work_packages/${parent_id}`);

        // Fetch child and set its parent
        const childRes = await api.get(`/work_packages/${child_id}`);
        const lockVersion: number = childRes.data.lockVersion;
        const childSubject: string = childRes.data.subject;

        const payload = {
            lockVersion,
            _links: { parent: { href: `/api/v3/work_packages/${parent_id}` } },
        };

        const res = await api.patch(`/work_packages/${child_id}`, payload);
        const updated = res.data;
        const newParent = updated._links?.parent?.title ?? `#${parent_id}`;

        return {
            content: [{
                type: "text",
                text: `✅ Đã thêm WP #${child_id} "${childSubject}" làm con của WP #${parent_id}\n` +
                      `   Parent: ${newParent}`,
            }],
        };
    },
);

// ── Tool: remove work package child ──────────────────────────────────────────

server.tool(
    "remove_work_package_child",
    "Xóa quan hệ cha-con: gỡ một work package con ra khỏi parent của nó (WP con trở thành WP gốc độc lập).",
    {
        parent_id: z.number().describe("ID của work package cha"),
        child_id: z.number().describe("ID của work package con cần gỡ"),
    },
    async ({ parent_id, child_id }) => {
        const childRes = await api.get(`/work_packages/${child_id}`);
        const lockVersion: number = childRes.data.lockVersion;
        const childSubject: string = childRes.data.subject;
        const currentParentHref: string | undefined = childRes.data._links?.parent?.href;

        if (!currentParentHref || !currentParentHref.includes(`/${parent_id}`)) {
            return {
                content: [{
                    type: "text",
                    text: `⚠️ Work package #${child_id} không phải là con trực tiếp của #${parent_id}.`,
                }],
            };
        }

        const payload = {
            lockVersion,
            _links: { parent: { href: null } },
        };

        await api.patch(`/work_packages/${child_id}`, payload);

        return {
            content: [{
                type: "text",
                text: `✅ Đã gỡ WP #${child_id} "${childSubject}" khỏi parent #${parent_id}.\n` +
                      `   WP #${child_id} hiện là work package gốc độc lập.`,
            }],
        };
    },
);

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
})();
