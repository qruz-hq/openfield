import { formatDateTime, t } from "@openfield/core";
import { Button, Modal, ModalClose, ModalContent, ModalDescription, ModalFooter } from "@openfield/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { useHealth } from "../api/hooks/settings";
import { checkForUpdate, installUpdate, isDesktop } from "../lib/desktop";
import { useIsGenerating } from "../lib/live";
import { notifyError } from "../lib/notify";
import { SettingRow, SettingsSection } from "./section";

// Settings · Updates: which version this is and, in the desktop app, whether a newer one is out,
// with Install and restart. The app also checks once after launch and from its menu
// (apps/desktop/src-tauri/src/updates.rs). A browser tab can't install anything, so there it
// shows the version and where releases live.

const RELEASES_URL = "https://github.com/qruz-hq/openfield/releases";

export function UpdatesPane() {
  const version = useHealth().data?.version;
  return (
    <>
      {isDesktop() ? <DesktopVersion fallback={version} /> : <BrowserVersion version={version} />}
      <SettingsSection label={t("settings.updates.whatsNew")}>
        <SettingRow
          title={t("settings.updates.releaseNotes")}
          description={t("settings.updates.releaseNotesHint")}
        >
          <Button asChild variant="secondary" size="s" icon={ArrowUpRight}>
            <a href={RELEASES_URL} target="_blank" rel="noreferrer">
              {t("settings.updates.openReleases")}
            </a>
          </Button>
        </SettingRow>
      </SettingsSection>
    </>
  );
}

function BrowserVersion({ version }: { version: string | undefined }) {
  return (
    <SettingsSection label={t("settings.updates.version")}>
      <SettingRow
        title={version ? t("settings.updates.current", { version }) : t("app.loading")}
        description={t("settings.updates.browser")}
      >
        {null}
      </SettingRow>
    </SettingsSection>
  );
}

function DesktopVersion({ fallback }: { fallback: string | undefined }) {
  const generating = useIsGenerating();
  const [asking, setAsking] = useState(false);
  // Checked each time the pane opens, then kept for a few minutes.
  const check = useQuery({
    queryKey: ["desktop-update"],
    queryFn: checkForUpdate,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const install = useMutation({
    mutationFn: installUpdate,
    // On success the app restarts, so only a failure comes back here.
    onError: (error) => notifyError(error.message),
  });

  const current = check.data?.current ?? fallback;
  const available = check.data?.available ?? null;
  const checking = check.isFetching;

  const status = install.isPending
    ? t("settings.updates.installing")
    : checking
      ? t("settings.updates.checking")
      : check.isError
        ? check.error.message
        : available
          ? t("settings.updates.available", { version: available })
          : check.isSuccess
            ? `${t("settings.updates.upToDate")} ${t("settings.updates.lastChecked", {
                when: formatDateTime(new Date(check.dataUpdatedAt)),
              })}`
            : "";

  const startInstall = () => {
    if (generating) setAsking(true);
    else install.mutate();
  };

  return (
    <>
      <SettingsSection label={t("settings.updates.version")}>
        <SettingRow
          title={current ? t("settings.updates.current", { version: current }) : t("app.loading")}
          description={<span aria-live="polite">{status}</span>}
        >
          {available ? (
            <Button variant="primary" size="s" loading={install.isPending} onClick={startInstall}>
              {t("settings.updates.install")}
            </Button>
          ) : (
            <Button variant="secondary" size="s" loading={checking} onClick={() => void check.refetch()}>
              {check.isError ? t("actions.tryAgain") : t("settings.updates.checkNow")}
            </Button>
          )}
        </SettingRow>
      </SettingsSection>
      {/* Outside the section: every child of one is a row with a hairline above it. */}
      <Modal open={asking} onOpenChange={setAsking}>
        <ModalContent alert title={t("settings.updates.confirmTitle")} closeLabel={t("actions.close")}>
          <ModalDescription>{t("settings.updates.confirmBody")}</ModalDescription>
          <ModalFooter>
            <ModalClose asChild>
              <Button variant="secondary">{t("settings.updates.notNow")}</Button>
            </ModalClose>
            <Button
              variant="primary"
              onClick={() => {
                setAsking(false);
                install.mutate();
              }}
            >
              {t("settings.updates.install")}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
