"use client";

/**
 * Connect sheet in the glass look: one wallet, Adena, on gno.land. Installed: connect it (Adena asks once per site
 * and switches to Mimir's network). Not installed: a link to adena.app.
 *
 * Keyboard, focus trap, Esc, aria-modal and pausing Lenis come from Modal.
 */
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import Modal from "@/components/ui/Modal";
import { useMimirWallet } from "@/hooks/useMimirWallet";
import { ADENA_INSTALL_URL, isUserRejection } from "@/lib/gno/adena";
import { MARKET_CHAINS } from "@/lib/chains/registry";

const rowClass =
  "group flex min-h-[58px] w-full items-center gap-3.5 rounded-2xl bg-cream/[0.04] px-3.5 py-2.5 text-left transition-[background-color,transform] duration-200 ease-out hover:bg-panel-raised focus-visible:bg-panel-raised active:scale-[.985] disabled:cursor-wait";

export default function ConnectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("wallet");
  const { installed, connect } = useMimirWallet();
  const chain = MARKET_CHAINS.chains.gno;

  const pick = () => {
    onClose();
    connect().then(
      () => toast.success(t("connected")),
      (e: unknown) => {
        if (!isUserRejection(e)) toast.error(e instanceof Error && e.message ? e.message : t("failed"));
      },
    );
  };

  const body = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- small static wallet icon */}
      <img src="/networks/adena-icon.svg" alt="" width={36} height={36} className="h-9 w-9 shrink-0 rounded-xl" />
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="font-display text-[1.3rem] leading-none text-cream">{installed ? t("adena") : t("installAdena")}</span>
        <span className="text-[13px] leading-snug text-muted">{installed ? t("adenaHint", { network: chain.name }) : t("installHint")}</span>
      </span>
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title={t("pickTitle")} variant="sheet" closeLabel={t("close")}>
      <p className="text-[14px] leading-snug text-muted">{t("pickLead")}</p>
      <ul className="mt-5 grid gap-2">
        <li>
          {installed ? (
            <button type="button" onClick={pick} className={rowClass}>{body}</button>
          ) : (
            <a href={ADENA_INSTALL_URL} target="_blank" rel="noreferrer" className={rowClass}>{body}</a>
          )}
        </li>
      </ul>
      <p className="mt-6 flex items-center gap-2 text-[12px] text-muted">
        <span aria-hidden className="h-[5px] w-[5px] rounded-full bg-coral" />
        {chain.network === "testnet" ? t("testnetFootnote") : t("footnote")}
      </p>
    </Modal>
  );
}
