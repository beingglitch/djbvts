import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { prisma } from "../../../../lib/prisma";
import { buildReportPdf } from "../../../../lib/report-pdf";
import { ensureUserByEmail } from "../../../../lib/users";
import { requireAuth, errorResponse } from "../../../../lib/auth";

// Force dynamic rendering for this API route
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KM_MATCHER = /[-+]?[0-9]*\.?[0-9]+/;

type Filters = {
  vehicle?: string;
  vehicles?: string[];
  area?: string | string[];
  month?: string;
  months?: string[];
};

type NormalizedFilters = {
  vehicles: string[];
  area: string | null;
  months: string[];
};

function normalizeFilters(filters: Filters = {} as Filters): NormalizedFilters {
  const vehicleArray = Array.isArray(filters.vehicles)
    ? filters.vehicles
    : filters.vehicle && filters.vehicle !== "all"
      ? [filters.vehicle]
      : [];

  const monthArray = Array.isArray(filters.months)
    ? filters.months
    : filters.month && filters.month !== "all"
      ? [filters.month]
      : [];

  const areaValue = Array.isArray(filters.area)
    ? filters.area[0] ?? null
    : filters.area && filters.area !== "all"
      ? filters.area
      : null;

  const uniqueVehicles = Array.from(new Set(vehicleArray.filter(Boolean)));
  const uniqueMonths = Array.from(new Set(monthArray.filter(Boolean)));

  return {
    vehicles: uniqueVehicles,
    area: areaValue,
    months: uniqueMonths,
  };
}

function parseDistance(value: string | null | undefined): number {
  if (!value) return 0;
  const match = value.match(KM_MATCHER);
  if (!match) return 0;
  const num = Number.parseFloat(match[0]);
  return Number.isNaN(num) ? 0 : num;
}

function buildSummary(rows: Array<{
  vehicleNo: string;
  area: string;
  tankerType: string;
  transporterName: string;
  tripDistanceKm: string | null;
  tripCount: number | null;
}>) {
  const vehicleMap = new Map<
    string,
    {
      area: string;
      tankerType: string;
      transporterName: string;
      totalDistance: number;
      totalTrips: number;
    }
  >();

  for (const row of rows) {
    const key = row.vehicleNo;
    const entry = vehicleMap.get(key) ?? {
      area: row.area,
      tankerType: row.tankerType,
      transporterName: row.transporterName,
      totalDistance: 0,
      totalTrips: 0,
    };

    entry.totalDistance += parseDistance(row.tripDistanceKm ?? "0");
    entry.totalTrips += row.tripCount ?? 0;

    vehicleMap.set(key, entry);
  }

  const vehicleReports = Array.from(vehicleMap.entries()).map(([vehicleNumber, entry]) => ({
    vehicleNumber,
    area: entry.area,
    tankerType: entry.tankerType,
    transporterName: entry.transporterName,
    totalDistance: Number(entry.totalDistance.toFixed(2)),
    totalTrips: entry.totalTrips,
    vehicleRecalculateCount: 0,
  }));

  const totalDistance = vehicleReports.reduce((sum, vehicle) => sum + vehicle.totalDistance, 0);
  const totalTrips = vehicleReports.reduce((sum, vehicle) => sum + vehicle.totalTrips, 0);

  return {
    vehicleReports,
    totalDistance: Number(totalDistance.toFixed(2)),
    totalTrips,
  };
}

export async function POST(req: NextRequest) {
  try {
    const claims = requireAuth(req);
    const generatorEmail = await ensureUserByEmail(claims.email);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const { dateFrom, dateTo, filters = {} as Filters } = body as {
      dateFrom?: unknown;
      dateTo?: unknown;
      filters?: Filters;
    };

    if (typeof dateFrom !== "string" || typeof dateTo !== "string" || !dateFrom || !dateTo) {
      return NextResponse.json({ error: "dateFrom and dateTo are required" }, { status: 400 });
    }

    const normalizedFilters = normalizeFilters(filters);

    const where = buildWhereClause(dateFrom, dateTo, normalizedFilters);

    let rows = await prisma.report.findMany({
      where,
      orderBy: [
        { vehicleNo: "asc" },
        { reportDate: "asc" },
      ],
    });

    // Filter by date range in memory since we're using DD-MM-YYYY format
    const fromDate = new Date(dateFrom);
    const toDate = new Date(dateTo);

    rows = rows.filter((row) => {
      const rowDate = parseDDMMYYYY(row.reportDate);
      if (!rowDate) return false;
      return rowDate >= fromDate && rowDate <= toDate;
    });

    if (rows.length === 0) {
      return NextResponse.json({ error: "No records match the selected filters" }, { status: 404 });
    }

    const generatedAt = new Date();
    const verificationCode = randomBytes(8).toString("hex");
    const normalizeReportCardUrl = (raw: string | undefined): string | null => {
      if (!raw) return null;
      let url = raw.trim().replace(/\/+$/, "");
      if (!url) return null;
      if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
      }
      if (!/\.html(\?|$)/i.test(url)) {
        url = `${url}/report-card.html`;
      }
      return url;
    };

    const defaultReportCard = process.env.NODE_ENV === "production"
      ? "https://djbvtswatsoo.com/report-card.html"
      : "http://localhost:3000/report-card.html";

    const reportCardBase =
      normalizeReportCardUrl(process.env.REPORT_CARD_URL) ??
      normalizeReportCardUrl(process.env.NEXT_PUBLIC_REPORT_CARD_URL) ??
      defaultReportCard;

    const verificationUrl = `${reportCardBase}?code=${encodeURIComponent(verificationCode)}`;

    const pdfBuffer = await buildReportPdf({
      title: "Daily Distance Report",
      dateFrom: new Date(dateFrom),
      dateTo: new Date(dateTo),
      generatedAt,
      generatedByEmail: generatorEmail,
      rows,
      verificationUrl,
    });

    const pdfBase64 = pdfBuffer.toString("base64");
    const summary = buildSummary(rows);

    const createPayload = {
      verificationCode,
      verificationUrl,
      dateFrom,
      dateTo,
      generatedBy: generatorEmail,
      generatedAt,
      filterVehicle: normalizedFilters.vehicles.length
        ? normalizedFilters.vehicles.join(", ")
        : null,
      filterArea: normalizedFilters.area,
      filterMonth: normalizedFilters.months.length
        ? normalizedFilters.months.join(", ")
        : null,
      pdfBase64,
      recordCount: rows.length,
      summaryVehicleReports: summary.vehicleReports,
      summaryTotalDistance: summary.totalDistance,
      summaryTotalTrips: summary.totalTrips,
      summaryVehicleCount: summary.vehicleReports.length,
      summaryGeneratedAt: generatedAt,
    };

    // Assert to Prisma type so builds with stale generated clients don't flag the summary fields.
    await prisma.pdfGeneration.create({
      data: createPayload as Prisma.PdfGenerationUncheckedCreateInput,
    });

    return NextResponse.json({
      success: true,
      pdfUrl: `/api/reports/pdf/${verificationCode}`,
      verificationUrl,
      verificationCode,
      recordCount: rows.length,
    });
  } catch (error: any) {
    if (error?.name === "AuthError") {
      return errorResponse(error);
    }
    console.error("Failed to generate PDF", error);
    const status = typeof error?.statusCode === "number" ? error.statusCode : 500;
    const message = status === 400 && error?.message ? error.message : "Failed to generate PDF";
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * Parse DD-MM-YYYY string to Date object for comparison
 */
function parseDDMMYYYY(dateStr: string): Date | null {
  const parts = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!parts) return null;
  const [, day, month, year] = parts;
  return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
}

function buildWhereClause(_dateFrom: string, _dateTo: string, filters: NormalizedFilters): Prisma.ReportWhereInput {
  // Date range filtering happens in memory after fetching because reportDate is
  // stored as a DD-MM-YYYY string and can't be range-compared lexicographically.
  const clauses: Prisma.ReportWhereInput[] = [];

  if (filters.vehicles.length > 0) {
    clauses.push({ vehicleNo: { in: filters.vehicles } });
  }

  if (filters.area) {
    clauses.push({ area: filters.area });
  }

  if (filters.months.length > 0) {
    clauses.push({
      OR: filters.months.flatMap((monthKey) => {
        // monthKey is in format "YYYY-MM" (e.g., "2025-08")
        // Need to match both date formats that may exist in DB:
        // 1. DD-MM-YYYY (e.g., "01-08-2025") - new format
        // 2. YYYY-MM-DD (e.g., "2025-08-01") - legacy format

        const parts = monthKey.split("-");
        if (parts.length !== 2) return [];

        const year = parts[0];
        const month = parts[1];
        const monthInt = parseInt(month, 10);
        if (isNaN(monthInt)) return [];

        const patterns = [];

        // Match DD-MM-YYYY format: "-08-2025" (primary format)
        patterns.push({ reportDate: { contains: `-${month}-${year}` } });

        // Match DD-M-YYYY format: "-8-2025" (unpadded month)
        if (month.startsWith("0")) {
          patterns.push({ reportDate: { contains: `-${monthInt}-${year}` } });
        }

        // Match YYYY-MM-DD format: "2025-08-" (legacy format)
        patterns.push({ reportDate: { startsWith: `${year}-${month}-` } });

        // Match YYYY-M-DD format: "2025-8-" (legacy unpadded)
        patterns.push({ reportDate: { startsWith: `${year}-${monthInt}-` } });

        return patterns;
      }),
    });
  }

  return clauses.length > 0 ? { AND: clauses } : {};
}
