import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";
import * as cheerio from "cheerio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
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

const createStatusError = (label, status) => {
  const error = new Error(`${label} failed with ${status}`);
  error.status = status;
  return error;
};

const summarizeError = (error) =>
  error instanceof Error ? error.message : String(error);

const isUnauthorizedError = (error) => error?.status === 401;

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
      }
    }
  }

  throw new Error(`${label} failed: ${summarizeError(lastError)}`, {
    cause: lastError,
  });
};

const selectRates = (rates, monthKey) => {
  const sorted = [...rates].sort((a, b) => a.from.localeCompare(b.from));
  const match = sorted.filter((rate) => rate.from <= monthKey).slice(-1)[0];
  return match ?? sorted[0];
};

const getStartMonthKey = (ledger, fallbackKey) => {
  const keys = (ledger.months ?? [])
    .map((monthEntry) => toMonthKey(monthEntry.year, monthEntry.month))
    .sort();

  return keys[0] ?? fallbackKey;
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
    throw createStatusError("Jamtkraft request", response.status);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const monthMap = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

  const parseNextData = () => {
    const nextDataRaw = $("#__NEXT_DATA__").text().trim();
    if (!nextDataRaw) {
      return null;
    }

    let nextData;
    try {
      nextData = JSON.parse(nextDataRaw);
    } catch {
      return null;
    }

    const content = nextData?.props?.pageProps?.componentProps?.content ?? [];
    const tables = content.map((block) => block.inlineTable).filter(Boolean);
    const targetTable = tables.find((table) => {
      const caption = String(table.caption ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      return caption.includes("elomr") && caption.endsWith("2");
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

        const numeric = Number(String(cell?.value ?? "").replace(",", ".").replace(/\s/g, ""));
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
    table.find("thead th").each((_, el) => {
      monthHeaders.push($(el).text().trim());
    });

    const rows = {};
    table.find("tbody tr").each((_, row) => {
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
    const yearRegex = /(\d{4})\s+((?:\d{1,3}[,.]\d{1,2}\s+){11}\d{1,3}[,.]\d{1,2})/g;
    const rows = {};
    let match;

    while ((match = yearRegex.exec(section))) {
      const year = Number(match[1]);
      const values = match[2]
        .trim()
        .split(/\s+/)
        .map((value) => Number(value.replace(",", ".")));

      if (values.length !== 12 || !Number.isFinite(year)) {
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
    throw createStatusError(`Easee monthly usage (${userId})`, response.status);
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
    throw createStatusError("Easee site users", response.status);
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
    throw createStatusError("Easee login", response.status);
  }

  const data = await response.json();
  if (!data?.accessToken) {
    throw new Error("Easee login response missing accessToken");
  }

  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? null,
  };
};

const createEaseeSessionManager = ({ userName, password, staticToken }) => {
  const canLogin = Boolean(userName && password);
  let session = null;

  const createStaticSession = () => {
    if (!staticToken) {
      return null;
    }

    return {
      accessToken: staticToken,
      refreshToken: null,
    };
  };

  const loginSession = async () => {
    if (!canLogin) {
      throw new Error(
        "Missing Easee credentials. Set EASEE_USERNAME/EASEE_PASSWORD or provide EASEE_TOKEN."
      );
    }

    session = await loginEasee(userName, password);
    return session;
  };

  const ensureSession = async () => {
    if (session) {
      return session;
    }

    if (canLogin) {
      return await loginSession();
    }

    const staticSession = createStaticSession();
    if (staticSession) {
      session = staticSession;
      return session;
    }

    throw new Error(
      "Missing Easee credentials. Set EASEE_USERNAME/EASEE_PASSWORD or provide EASEE_TOKEN."
    );
  };

  const request = async (operation) => {
    await ensureSession();
    let retriedUnauthorized = false;

    while (true) {
      try {
        return await operation(session.accessToken);
      } catch (error) {
        if (!isUnauthorizedError(error) || !canLogin || retriedUnauthorized) {
          throw error;
        }

        retriedUnauthorized = true;
        session = await loginSession();
      }
    }
  };

  return {
    request,
  };
};

const calculateMonth = ({ spotOreInclVat, meKWh, neighborKWh, rates }) => {
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

const buildUpdatedMonths = ({
  ledger,
  monthList,
  jamtkraftData,
  hasJamtkraftData,
  meUsage,
  neighborUsage,
  hasEaseeData,
}) => {
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

    const existingInputs = existing?.inputs ?? {};
    const spotOreInclVat = hasJamtkraftData
      ? jamtkraftData?.[year]?.[month] ?? null
      : existingInputs.spotOreInclVat ?? null;
    const meKWh = hasEaseeData
      ? meUsage.get(monthKey) ?? null
      : existingInputs.meKWh ?? null;
    const neighborKWh = hasEaseeData
      ? neighborUsage.get(monthKey) ?? null
      : existingInputs.neighborKWh ?? null;
    const selectedRates = selectRates(ledger.rates, monthKey);
    const calculated = calculateMonth({
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

  return updatedMonths;
};

const main = async () => {
  const ledgerRaw = await fs.readFile(docsDataPath, "utf8");
  const ledger = JSON.parse(ledgerRaw);
  const lastClosed = getLastClosedMonth();
  const endKey = toMonthKey(lastClosed.year, lastClosed.month);
  const startKey = getStartMonthKey(ledger, endKey);
  const monthList = startKey <= endKey ? listMonths(startKey, endKey) : [];

  console.log(`Updating ledger months ${startKey} -> ${endKey}`);

  let jamtkraftData = {};
  let meUsage = new Map();
  let neighborUsage = new Map();
  let hasJamtkraftData = false;
  let hasEaseeData = false;
  const sourceErrors = [];

  try {
    jamtkraftData = await parseJamtkraft();
    hasJamtkraftData = true;
    console.log("Jamtkraft prices loaded.");
  } catch (error) {
    const message = summarizeError(error);
    sourceErrors.push(message);
    console.warn(`Jamtkraft sync unavailable: ${message}`);
  }

  try {
    const easee = createEaseeSessionManager({
      userName: process.env.EASEE_USERNAME?.trim(),
      password: process.env.EASEE_PASSWORD?.trim(),
      staticToken: process.env.EASEE_TOKEN?.trim(),
    });

    const siteUsers = await easee.request((token) =>
      fetchEaseeSiteUsers(ledger.identities.siteId, token)
    );

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
      const missing = expectedUserIds.filter((id) => !availableUserIds.includes(id));
      if (missing.length) {
        throw new Error(
          `Easee userId(s) not found on site ${ledger.identities.siteId}. Missing: ${missing.join(
            ", "
          )}. Available: ${availableUserIds.join(", ")}`
        );
      }
    }

    meUsage = await easee.request((token) =>
      fetchEaseeMonthlyUsage(ledger.identities.siteId, ledger.identities.meUserId, token)
    );
    neighborUsage = await easee.request((token) =>
      fetchEaseeMonthlyUsage(
        ledger.identities.siteId,
        ledger.identities.neighborUserId,
        token
      )
    );

    hasEaseeData = true;
    console.log("Easee usage loaded.");
  } catch (error) {
    const message = summarizeError(error);
    sourceErrors.push(message);
    console.warn(`Easee sync unavailable: ${message}`);
  }

  if (hasJamtkraftData || hasEaseeData) {
    ledger.months = buildUpdatedMonths({
      ledger,
      monthList,
      jamtkraftData,
      hasJamtkraftData,
      meUsage,
      neighborUsage,
      hasEaseeData,
    });
    console.log(`Ledger now contains ${ledger.months.length} months.`);
  } else {
    console.warn("No data source succeeded; preserving existing months.");
  }

  ledger.meta.updatedAtUtc = new Date().toISOString();
  ledger.meta.lastRunStatus = sourceErrors.length ? "FAIL" : "OK";
  ledger.meta.lastError = sourceErrors.length ? sourceErrors.join(" | ") : null;

  const payload = `${JSON.stringify(ledger, null, 2)}\n`;
  await fs.writeFile(docsDataPath, payload);
};

main().catch((error) => {
  console.error(`Ledger update failed: ${summarizeError(error)}`);
  process.exitCode = 1;
});
