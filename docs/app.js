(() => {
  const app = angular.module("chargingRally", []);

  app.controller("MainController", ["$http", "$scope", function ($http, $scope) {
    const vm = this;

    vm.state = {
      ledger: null,
      profileKey: null,
      profile: null,
      monthOptions: [],
      selectedStart: null,
      selectedEnd: null,
      filteredMonths: [],
      totalSum: 0,
    };

    vm.formatCurrency = (value) => {
      if (value == null) {
        return "-";
      }
      return `${value.toFixed(2).replace(".", ",")} kr`;
    };

    vm.formatMonth = (year, month) =>
      `${year}-${String(month).padStart(2, "0")}`;

    vm.selectProfile = (profileKey) => {
      vm.state.profileKey = profileKey;
      vm.state.profile = vm.state.ledger.profiles[profileKey];
      vm.resetFilters();
    };

    vm.resetProfile = () => {
      vm.state.profileKey = null;
      vm.state.profile = null;
      vm.state.filteredMonths = [];
      vm.state.totalSum = 0;
    };

    vm.resetFilters = () => {
      const months = vm.state.ledger.months || [];
      vm.state.monthOptions = months.map((entry) =>
        vm.formatMonth(entry.year, entry.month)
      );
      vm.state.selectedStart = vm.state.monthOptions[0] || null;
      vm.state.selectedEnd =
        vm.state.monthOptions[vm.state.monthOptions.length - 1] || null;
      vm.updateSummary();
    };

    vm.updateSummary = () => {
      if (!vm.state.profileKey || !vm.state.ledger) {
        return;
      }

      const startValue = vm.state.selectedStart;
      const endValue = vm.state.selectedEnd;
      const filtered = (vm.state.ledger.months || []).filter((entry) => {
        const key = vm.formatMonth(entry.year, entry.month);
        return key >= startValue && key <= endValue;
      });

      let sum = 0;
      vm.state.filteredMonths = filtered.map((entry) => {
        const key = vm.formatMonth(entry.year, entry.month);
        const result = entry.result[vm.state.profileKey];
        const warnings = entry.warnings || [];
        const warningTitle = warnings.join(", ");
        const warningIcon = warnings.length ? "⚠️" : "";
        const kwhKey =
          vm.state.profileKey === "me" ? "meKWh" : "neighborKWh";

        sum += result.totalKr;

        return {
          key,
          result,
          warningIcon,
          warningTitle,
          kwhDisplay: entry.inputs[kwhKey] ?? "-",
          spotDisplay: entry.inputs.spotOreInclVat ?? "-",
        };
      });

      vm.state.totalSum = sum;
    };

    const loadLedger = async () => {
      const response = await $http.get("./data/ledger.json", {
        cache: false,
      });
      return response.data;
    };

    loadLedger()
      .then((ledger) => {
        vm.state.ledger = ledger;
      })
      .catch(() => {
        vm.state.ledger = {
          meta: { updatedAtUtc: "N/A" },
          months: [],
          profiles: {},
          rates: [],
        };
      });

    $scope.$watchGroup(
      ["vm.state.selectedStart", "vm.state.selectedEnd", "vm.state.profileKey"],
      () => {
        vm.updateSummary();
      }
    );
  }]);
})();
