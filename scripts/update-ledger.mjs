import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const dataPath = path.join(repoRoot, "data", "ledger.json");
const docsDataPath = path.join(repoRoot, "docs", "data", "ledger.json");

const JAMTKRAFT_URL =
  "https://www.jamtkraft.se/privat/elavtal/vara-elavtal/rorligt-elpris/prishistorik-rorlig-elpris/";

const toMonthKey = (year, month) => `${year}-${String(month).padStart(2, "0")}`;

const parseMonthKey = (monthKey) => {
  const [yearStr, monthStr] = monthKey.split("-");
  return {
    year: Number(yearStr),
    month: Number(monthStr),
  };
};

const getLastClosedMonth = (now = new Date()) => {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  if (month === 1) {
    return { year: year - 1, month: 12 };
  }
  return { year, month: month - 1 };
};

const listMonths = (startKey, endKey) => {
  const start = parseMonthKey(startKey);
  const end = parseMonthKey(endKey);
  const months = [];
  let year = start.year;
  let month = start.month;
  while (year < end.year || (year === end.year && month <= end.month)) {
    months.push({ year, month });
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return months;
};

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

const selectRates = (rates, monthKey) => {
  const sorted = [...rates].sort((a, b) => a.from.localeCompare(b.from));
  const match = sorted
    .filter((rate) => rate.from <= monthKey)
    .slice(-1)[0];
  if (!match) {
    return sorted[0];
  }
  return match;
};

const parseJamtkraft = async () => {
  const response = await fetch(JAMTKRAFT_URL);
  if (!response.ok) {
    throw new Error(`Jamtkraft request failed with ${response.status}`);
  }
  const html = await response.text();
  const $ = cheerio.load(html);
  const table = $("table").filter((_, tableEl) => {
    const captionText = $(tableEl).find("caption").text().trim();
    return captionText === "Elområde 2";
  });
  if (!table.length) {
    throw new Error("Could not find Jamtkraft table with caption 'Elområde 2'");
  }

  const monthHeaders = [];
  table
    .find("thead th")
    .each((_, el) => {
      monthHeaders.push($(el).text().trim());
    });

  const monthMap = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    maj: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    okt: 10,
    nov: 11,
    dec: 12,
  };

  const rows = {};
  table
    .find("tbody tr")
    .each((_, row) => {
      const cells = $(row)
        .find("th, td")
        .map((_, cell) => $(cell).text().trim())
        .get();
      const year = Number(cells[0]);
      if (!Number.isFinite(year)) {
        return;
      }
      const monthValues = {};
      cells.slice(1).forEach((cellText, index) => {
        const header = monthHeaders[index + 1] || "";
        const normalizedHeader = header.slice(0, 3).toLowerCase();
        const monthIndex = monthMap[normalizedHeader];
        if (!monthIndex) {
          return;
        }
        const numeric = Number(cellText.replace(",", ".").replace(/\s/g, ""));
        if (Number.isFinite(numeric)) {
          monthValues[monthIndex] = numeric;
        }
      });
      rows[year] = monthValues;
    });

  return rows;
};

const fetchEaseeMonthlyUsage = async (siteId, userId, token) => {
  const response = await fetch(
    `https://api.easee.com/api/sites/${siteId}/users/${userId}/monthly`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );
  if (!response.ok) {
    throw new Error(`Easee API failed for ${userId} with ${response.status}`);
  }
  const data = await response.json();
  const usage = new Map();
  for (const entry of data || []) {
    if (entry.year && entry.month) {
      usage.set(toMonthKey(entry.year, entry.month), entry.totalEnergyUsage);
    }
  }
  return usage;
};

const loginEasee = async (userName, password) => {
  const response = await fetch("https://api.easee.com/api/accounts/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userName, password }),
  });
  if (!response.ok) {
    throw new Error(`Easee login failed with ${response.status}`);
  }
  const data = await response.json();
  if (!data?.accessToken) {
    throw new Error("Easee login response missing accessToken");
  }
  return data.accessToken;
};

const calculateMonth = ({
  monthKey,
  spotOreInclVat,
  meKWh,
  neighborKWh,
  rates,
}) => {
  const warnings = [];
  if (spotOreInclVat == null) {
    warnings.push("MissingJamtkraftPrice");
  }
  if (meKWh == null) {
    warnings.push("MissingEaseeUsageMe");
  }
  if (neighborKWh == null) {
    warnings.push("MissingEaseeUsageNeighbor");
  }

  const appliedRates = {
    localDiscountOreInclVat: rates.localDiscountOreInclVat,
    gridTransferOreInclVat: rates.gridTransferOreInclVat,
    energyTaxOreInclVat: rates.energyTaxOreInclVat,
    norrlandDeductionOreInclVat: rates.norrlandDeductionOreInclVat,
  };

  const adjustedElPriceOre =
    spotOreInclVat != null
      ? spotOreInclVat - rates.localDiscountOreInclVat
      : null;

  const buildResult = (kwh) => {
    if (spotOreInclVat == null || kwh == null) {
      return {
        adjustedElPriceOre,
        elhandelKr: 0,
        elnatKr: 0,
        totalKr: 0,
      };
    }
    const elhandelKr = round2((kwh * adjustedElPriceOre) / 100);
    const elnatKr = round2(
      (kwh *
        (rates.gridTransferOreInclVat +
          rates.energyTaxOreInclVat +
          rates.norrlandDeductionOreInclVat)) /
        100
    );
    const totalKr = round2(elhandelKr + elnatKr);
    return {
      adjustedElPriceOre: round2(adjustedElPriceOre),
      elhandelKr,
      elnatKr,
      totalKr,
    };
  };

  return {
    inputs: {
      spotOreInclVat,
      meKWh,
      neighborKWh,
    },
    appliedRates,
    result: {
      me: buildResult(meKWh),
      neighbor: buildResult(neighborKWh),
    },
    warnings,
  };
};

const main = async () => {
  const ledgerRaw = await fs.readFile(dataPath, "utf8");
  const ledger = JSON.parse(ledgerRaw);
  const tokenFromEnv = process.env.EASEE_TOKEN;
  const easeeUserName = process.env.EASEE_USERNAME;
  const easeePassword = process.env.EASEE_PASSWORD;
  const lastClosed = getLastClosedMonth();
  const startKey = "2024-01";
  const endKey = toMonthKey(lastClosed.year, lastClosed.month);
  const monthList = listMonths(startKey, endKey);

  let jamtkraftData = {};
  let meUsage = new Map();
  let neighborUsage = new Map();
  let lastError = null;
  let lastRunStatus = "OK";

  try {
    jamtkraftData = await parseJamtkraft();
    let token = tokenFromEnv;
    if (!token) {
      if (!easeeUserName || !easeePassword) {
        throw new Error(
          "Missing Easee credentials. Set EASEE_TOKEN or EASEE_USERNAME/EASEE_PASSWORD."
        );
      }
      token = await loginEasee(easeeUserName, easeePassword);
    }
    meUsage = await fetchEaseeMonthlyUsage(
      ledger.identities.siteId,
      ledger.identities.meUserId,
      token
    );
    neighborUsage = await fetchEaseeMonthlyUsage(
      ledger.identities.siteId,
      ledger.identities.neighborUserId,
      token
    );
  } catch (error) {
    lastRunStatus = "FAIL";
    lastError = error instanceof Error ? error.message : String(error);
  }

  if (lastRunStatus === "OK") {
    const monthMap = new Map(
      (ledger.months || []).map((monthEntry) => [
        toMonthKey(monthEntry.year, monthEntry.month),
        monthEntry,
      ])
    );

    const updatedMonths = [];

    for (const { year, month } of monthList) {
      const monthKey = toMonthKey(year, month);
      const existing = monthMap.get(monthKey);
      if (existing?.isLocked) {
        updatedMonths.push(existing);
        continue;
      }

      const spotOreInclVat = jamtkraftData?.[year]?.[month] ?? null;
      const meKWh = meUsage.get(monthKey) ?? null;
      const neighborKWh = neighborUsage.get(monthKey) ?? null;
      const selectedRates = selectRates(ledger.rates, monthKey);

      const calculated = calculateMonth({
        monthKey,
        spotOreInclVat,
        meKWh,
        neighborKWh,
        rates: selectedRates,
      });

      updatedMonths.push({
        year,
        month,
        isLocked: existing?.isLocked ?? false,
        ...calculated,
      });
    }

    ledger.months = updatedMonths;
  }
  ledger.meta.updatedAtUtc = new Date().toISOString();
  ledger.meta.lastRunStatus = lastRunStatus;
  ledger.meta.lastError = lastError;

  const payload = `${JSON.stringify(ledger, null, 2)}\n`;
  await fs.writeFile(dataPath, payload);
  await fs.writeFile(docsDataPath, payload);
};

main();
