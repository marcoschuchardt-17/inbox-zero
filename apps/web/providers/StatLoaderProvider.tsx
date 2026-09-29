"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useSWRConfig } from "swr";
import { toastError, toastSuccess } from "@/components/Toast";
import { isError } from "@/utils/error";
import { loadEmailStatsAction } from "@/utils/actions/stats";
import { statsLoadHasMore } from "@/utils/stats/load-progress";
import { useAccount } from "@/providers/EmailAccountProvider";

type Context = {
  isLoading: boolean;
  onLoad: (options: {
    loadBefore: boolean;
    showToast: boolean;
  }) => Promise<void>;
  onLoadBatch: (options: {
    loadBefore: boolean;
    showToast: boolean;
  }) => Promise<void>;
  onCancelLoadBatch: () => void;
};

const StatLoaderContext = createContext<Context>({
  isLoading: false,
  onLoad: async () => {},
  onLoadBatch: async () => {},
  onCancelLoadBatch: () => {},
});

export const useStatLoader = () => useContext(StatLoaderContext);

class StatLoader {
  #isLoading = false;

  async loadStats({
    emailAccountId,
    loadBefore,
    showToast,
  }: {
    emailAccountId: string;
    loadBefore: boolean;
    showToast: boolean;
  }) {
    if (this.#isLoading) return;

    this.#isLoading = true;

    const res = await loadEmailStatsAction(emailAccountId, { loadBefore });

    if (showToast) {
      if (isError(res) || res?.serverError) {
        toastError({ description: "Error loading stats." });
      } else {
        toastSuccess({ description: "Stats loaded!" });
      }
    }

    this.#isLoading = false;
    return res;
  }
}

const statLoader = new StatLoader();

export function StatLoaderProvider(props: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(false);
  const [stopLoading, setStopLoading] = useState(false);
  const { emailAccountId } = useAccount();
  const { mutate } = useSWRConfig();

  const refreshStoredStats = useCallback(
    () => mutate(isStoredStatsKey),
    [mutate],
  );

  const onLoad = useCallback(
    async (options: { loadBefore: boolean; showToast: boolean }) => {
      setIsLoading(true);
      try {
        await statLoader.loadStats({
          emailAccountId,
          loadBefore: options.loadBefore,
          showToast: options.showToast,
        });
      } finally {
        setIsLoading(false);
        await refreshStoredStats().catch(() => undefined);
      }
    },
    [emailAccountId, refreshStoredStats],
  );

  const onLoadBatch = useCallback(
    async (options: { loadBefore: boolean; showToast: boolean }) => {
      setIsLoading(true);
      let failed = false;
      try {
        for (let i = 0; i < 50; i++) {
          if (stopLoading) break;
          const res = await statLoader.loadStats({
            emailAccountId,
            loadBefore: options.loadBefore,
            showToast: false,
          });
          if (res?.serverError) {
            failed = true;
            break;
          }
          if (!statsLoadHasMore(options.loadBefore, res?.data)) break;
        }
      } finally {
        setIsLoading(false);
        setStopLoading(false);
        await refreshStoredStats().catch(() => undefined);
      }
      if (!options.showToast) return;
      if (failed) {
        toastError({ description: "Error loading stats." });
      } else {
        toastSuccess({ description: "Stats loaded!" });
      }
    },
    [emailAccountId, refreshStoredStats, stopLoading],
  );

  const onCancelLoadBatch = useCallback(() => {
    setStopLoading(true);
  }, []);

  return (
    <StatLoaderContext.Provider
      value={{ isLoading, onLoad, onLoadBatch, onCancelLoadBatch }}
    >
      {props.children}
    </StatLoaderContext.Provider>
  );
}

export function LoadStats(props: { loadBefore: boolean; showToast: boolean }) {
  const { onLoad } = useStatLoader();

  useEffect(() => {
    onLoad(props);
  }, [onLoad, props]);

  return null;
}

function isStoredStatsKey(key: unknown) {
  return typeof key === "string" && key.includes("/api/user/stats");
}
