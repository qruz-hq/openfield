import { formatMoney, formatNumber, t } from "@openfield/core";
import { Banner } from "@openfield/ui";
import { useSpentToday } from "../api/hooks/usage";
import { errorMessage } from "../api/raw";
import { SettingRow, SettingsSection } from "./section";

// Settings · Spending: what today's images cost.

export function SpendingPane() {
  const spent = useSpentToday();
  if (spent.isError) return <Banner variant="error" message={errorMessage(spent.error)} />;
  if (!spent.data) return null;
  const images = spent.data.rows.reduce((sum, row) => sum + row.images, 0);
  // Images that ran again after a restart: the company may have billed the cut-off call as well.
  const reruns = spent.data.rows.reduce((sum, row) => sum + (row.reruns ?? 0), 0);

  return (
    <SettingsSection label={t("settings.spending.ranges.today")}>
      <SettingRow title={t("settings.spending.spent")}>
        <span className="shrink-0 text-mono-12 text-text-primary">
          {formatMoney(spent.data.totalUsd, spent.data.currency, true)}
        </span>
      </SettingRow>
      <SettingRow
        title={t("settings.spending.imagesMade")}
        description={reruns > 0 ? t("settings.spending.reruns", { count: reruns }) : undefined}
      >
        <span className="shrink-0 text-mono-12 text-text-primary">{formatNumber(images)}</span>
      </SettingRow>
    </SettingsSection>
  );
}
