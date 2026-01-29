const state = {
  ledger: null,
  profile: null,
};

const profilePicker = document.getElementById("profile-picker");
const profileView = document.getElementById("profile-view");
const profileImage = document.getElementById("profile-image");
const profileLabel = document.getElementById("profile-label");
const profileVehicle = document.getElementById("profile-vehicle");
const updatedAt = document.getElementById("updated-at");
const startMonthSelect = document.getElementById("start-month");
const endMonthSelect = document.getElementById("end-month");
const totalSum = document.getElementById("total-sum");
const monthRows = document.getElementById("month-rows");
const ratesTable = document.getElementById("rates-table");
const backButton = document.getElementById("back-button");

const loadLedger = async () => {
  const response = await fetch("./data/ledger.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Kunde inte läsa JSON");
  }
  return response.json();
};

const formatMonth = (year, month) => {
  return `${year}-${String(month).padStart(2, "0")}`;
};

const formatCurrency = (value) =>
  `${value.toFixed(2).replace(".", ",")} kr`;

const buildOptions = (months) => {
  return months
    .map((entry) => {
      const label = `${entry.year}-${String(entry.month).padStart(2, "0")}`;
      return `<option value="${label}">${label}</option>`;
    })
    .join("");
};

const updateSummary = () => {
  if (!state.ledger || !state.profile) {
    return;
  }
  const months = state.ledger.months;
  const startValue = startMonthSelect.value;
  const endValue = endMonthSelect.value;

  const filtered = months.filter((entry) => {
    const key = formatMonth(entry.year, entry.month);
    return key >= startValue && key <= endValue;
  });

  let sum = 0;
  monthRows.innerHTML = "";

  filtered.forEach((entry) => {
    const result = entry.result[state.profile];
    const warnings = entry.warnings || [];
    const warningIcon = warnings.length ? "⚠️" : "";
    const warningTitle = warnings.join(", ");
    sum += result.totalKr;
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${formatMonth(entry.year, entry.month)}</td>
      <td>${entry.inputs[state.profile === "me" ? "meKWh" : "neighborKWh"] ?? "-"}</td>
      <td>${entry.inputs.spotOreInclVat ?? "-"}</td>
      <td>${formatCurrency(result.elhandelKr)}</td>
      <td>${formatCurrency(result.elnatKr)}</td>
      <td>${formatCurrency(result.totalKr)}</td>
      <td class="warning" title="${warningTitle}">${warningIcon}</td>
    `;
    monthRows.appendChild(row);
  });

  totalSum.textContent = formatCurrency(sum);
};

const renderRates = () => {
  if (!state.ledger) {
    return;
  }
  const rows = state.ledger.rates
    .map(
      (rate) => `
      <tr>
        <td>${rate.from}</td>
        <td>${rate.localDiscountOreInclVat}</td>
        <td>${rate.gridTransferOreInclVat}</td>
        <td>${rate.energyTaxOreInclVat}</td>
        <td>${rate.norrlandDeductionOreInclVat}</td>
      </tr>
    `
    )
    .join("");
  ratesTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Gäller från</th>
          <th>Lokal rabatt (öre)</th>
          <th>Nätöverföring (öre)</th>
          <th>Energiskatt (öre)</th>
          <th>Norrlandsavdrag (öre)</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
};

const selectProfile = (profileKey) => {
  state.profile = profileKey;
  const profile = state.ledger.profiles[profileKey];
  profileImage.src = profile.image;
  profileImage.alt = profile.vehicle;
  profileLabel.textContent = profile.label;
  profileVehicle.textContent = profile.vehicle;
  updatedAt.textContent = `Senast uppdaterad: ${state.ledger.meta.updatedAtUtc}`;

  const months = state.ledger.months;
  const options = buildOptions(months);
  startMonthSelect.innerHTML = options;
  endMonthSelect.innerHTML = options;
  startMonthSelect.value = options ? months[0] && formatMonth(months[0].year, months[0].month) : "";
  endMonthSelect.value = options
    ? formatMonth(months[months.length - 1].year, months[months.length - 1].month)
    : "";

  profilePicker.classList.add("hidden");
  profileView.classList.remove("hidden");
  renderRates();
  updateSummary();
};

const init = async () => {
  state.ledger = await loadLedger();
  document.querySelectorAll(".profile-button").forEach((button) => {
    button.addEventListener("click", () => {
      selectProfile(button.dataset.profile);
    });
  });

  startMonthSelect.addEventListener("change", updateSummary);
  endMonthSelect.addEventListener("change", updateSummary);

  backButton.addEventListener("click", () => {
    profileView.classList.add("hidden");
    profilePicker.classList.remove("hidden");
  });
};

init();
