import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const insecureDispatcher = new Agent({
  connect: { rejectUnauthorized: false },
});

const fetchWithRetry = async (
  url,
  options,
  { retries = 3, retryDelayMs = 1000, label = "Fetch", allowInsecureTls = false } = {}
) => {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      const primaryCause = error?.cause;
      const tlsCode = primaryCause?.code ?? primaryCause?.cause?.code;
      const shouldFallback = allowInsecureTls && tlsCode === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
      if (shouldFallback) {
        return await fetch(url, { ...options, dispatcher: insecureDispatcher });
      }
      if (attempt < retries) {
        await wait(retryDelayMs * attempt);
        continue;
      }
    }
  }
  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} failed: ${message}`, { cause: lastError });
};

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
  const response = await fetchWithRetry(
    JAMTKRAFT_URL,
    {
      headers: {
        "User-Agent": "the-charging-rally/1.0",
        Accept: "text/html",
      },
      redirect: "follow",
    },
    { label: "Jamtkraft fetch", allowInsecureTls: true }
  );
  if (!response.ok) {
    throw new Error(`Jamtkraft request failed with ${response.status}`);
  }
  const html = await response.text();
  const $ = cheerio.load(html);

  const monthMap = [
    "jan",
    "feb",
    "mar",
    "apr",
    "maj",
    "jun",
    "jul",
    "aug",
    "sep",
    "okt",
    "nov",
    "dec",
  ];

  const parseNextData = () => {
    const nextDataRaw = $("#__NEXT_DATA__").text().trim();
    if (!nextDataRaw) {
      return null;
    }
    let nextData;
    try {
      nextData = JSON.parse(nextDataRaw);
    } catch (error) {
      return null;
    }
    const content = nextData?.props?.pageProps?.componentProps?.content ?? [];
    const tables = content.map((block) => block.inlineTable).filter(Boolean);
    const targetTable = tables.find((table) => {
      const caption = String(table.caption ?? "").replace(/\s+/g, " ").trim();
      return caption.endsWith("2") && caption.toLowerCase().includes("elomr");
    });
    if (!targetTable?.rows?.length) {
      return null;
    }

    const [headerRow, ...dataRows] = targetTable.rows;
    const monthHeaders = (headerRow || [])
      .slice(1)
      .map((cell) => String(cell?.value ?? "").trim());

    const rows = {};
    for (const row of dataRows) {
      const cells = row || [];
      const year = Number(String(cells[0]?.value ?? "").replace(/\s/g, ""));
      if (!Number.isFinite(year)) {
        continue;
      }
      const monthValues = {};
      cells.slice(1).forEach((cell, index) => {
        const header = monthHeaders[index] || "";
        const normalizedHeader = header.slice(0, 3).toLowerCase();
        const monthIndex = monthMap.indexOf(normalizedHeader) + 1;
        if (!monthIndex) {
          return;
        }
        const numeric = Number(
          String(cell?.value ?? "").replace(",", ".").replace(/\s/g, "")
        );
        if (Number.isFinite(numeric)) {
          monthValues[monthIndex] = numeric;
        }
      });
      rows[year] = monthValues;
    }

    return Object.keys(rows).length ? rows : null;
  };

  const parseTable = () => {
    const table = $("table").filter((_, tableEl) => {
      const captionText = $(tableEl).find("caption").text().trim();
      return captionText === "Elområde 2";
    });
    if (!table.length) {
      return null;
    }

    const monthHeaders = [];
    table
      .find("thead th")
      .each((_, el) => {
        monthHeaders.push($(el).text().trim());
      });

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
          const monthIndex = monthMap.indexOf(normalizedHeader) + 1;
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

    return Object.keys(rows).length ? rows : null;
  };

  const parseText = () => {
    const bodyText = $("body").text().replace(/\s+/g, " ").trim();
    const sectionIndex = bodyText.indexOf("Elområde 2");
    if (sectionIndex === -1) {
      return null;
    }
    const section = bodyText.slice(sectionIndex);
    const yearRegex =
      /(\d{4})\s+((?:\d{1,3}[,.]\d{1,2}\s+){11}\d{1,3}[,.]\d{1,2})/g;
    const rows = {};
    let match;
    while ((match = yearRegex.exec(section))) {
      const year = Number(match[1]);
      const values = match[2]
        .trim()
        .split(/\s+/)
        .map((value) => Number(value.replace(",", ".")));
      if (values.length != 12 || !Number.isFinite(year)) {
        continue;
      }
      const monthValues = {};
      values.forEach((value, index) => {
        if (Number.isFinite(value)) {
          monthValues[index + 1] = value;
        }
      });
      rows[year] = monthValues;
    }
    return Object.keys(rows).length ? rows : null;
  };

  const parsed = parseNextData() ?? parseTable() ?? parseText();
  if (!parsed) {
    throw new Error("Could not parse Jamtkraft Elområde 2 data");
  }
  return parsed;
};

const fetchEaseeMonthlyUsage = async (siteId, userId, token) => {
  const response = await fetchWithRetry(
    `https://api.easee.com/api/sites/${siteId}/users/${userId}/monthly`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
    { label: `Easee monthly usage (${userId})` }
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

const fetchEaseeSiteUsers = async (siteId, token) => {
  const response = await fetchWithRetry(
    `https://api.easee.com/api/sites/${siteId}/users`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
    { label: `Easee site users (${siteId})` }
  );
  if (!response.ok) {
    throw new Error(`Easee site users failed with ${response.status}`);
  }
  return await response.json();
};

const extractUserId = (user) => {
  if (typeof user === "number") {
    return user;
  }
  if (typeof user === "string") {
    const parsed = Number(user);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (!user || typeof user !== "object") {
    return null;
  }
  const candidate = user.userId ?? user.userID ?? user.id ?? user.user?.id;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
};

const loginEasee = async (userName, password) => {
  const response = await fetchWithRetry(
    "https://api.easee.com/api/accounts/login",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userName, password }),
    },
    { label: "Easee login" }
  );
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
    const siteUsers = await fetchEaseeSiteUsers(ledger.identities.siteId, token);
    const usersArray = Array.isArray(siteUsers)
      ? siteUsers
      : siteUsers?.users ?? siteUsers?.data ?? [];
    const availableUserIds = usersArray
      .map(extractUserId)
      .filter((id) => Number.isFinite(id));
    if (availableUserIds.length) {
      const expectedUserIds = [
        ledger.identities.meUserId,
        ledger.identities.neighborUserId,
      ].filter((id) => Number.isFinite(id));
      const missing = expectedUserIds.filter(
        (id) => !availableUserIds.includes(id)
      );
      if (missing.length) {
        throw new Error(
          `Easee userId(s) not found on site ${ledger.identities.siteId}. Missing: ${missing.join(
            ", "
          )}. Available: ${availableUserIds.join(", ")}`
        );
      }
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

