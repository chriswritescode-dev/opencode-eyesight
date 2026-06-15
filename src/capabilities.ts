/**
 * Minimal structural type matching the provider list response shape.
 * Only captures the fields used for image-modality detection.
 */
export type ProviderListData = {
  all: Array<{
    id: string;
    models: Record<
      string,
      {
        modalities?: { input: string[]; output: string[] };
      }
    >;
  }>;
  default: Record<string, string>;
  connected: string[];
};

/**
 * Pure function that checks whether a given provider/model supports image input.
 * Returns `false` if the provider, model, or modalities are missing/undefined.
 */
export function supportsImageInput(
  data: ProviderListData,
  providerID: string,
  modelID: string,
): boolean {
  const provider = data.all.find((p) => p.id === providerID);
  return provider?.models[modelID]?.modalities?.input?.includes("image") ?? false;
}

/**
 * Creates a memoized async lookup function that checks whether a given
 * provider/model supports image input.
 *
 * The provider list is fetched lazily on first call and cached. If a lookup
 * misses the provider or model entirely, the cache is cleared and refetched
 * once to handle newly-added providers.
 *
 * On fetch errors or absent data, returns `false` (fail-closed toward
 * transcription rather than silently dropping).
 */
export function makeCapabilityLookup(
  client: {
    provider: {
      list: () => Promise<{ data?: ProviderListData; error?: unknown }>;
    };
  },
): (providerID: string, modelID: string) => Promise<boolean> {
  let cachedData: ProviderListData | undefined;
  let fetching: Promise<ProviderListData | undefined> | undefined;

  async function getData(forceRefresh = false): Promise<ProviderListData | undefined> {
    if (forceRefresh) {
      fetching = undefined;
      cachedData = undefined;
    }
    if (cachedData !== undefined) return cachedData;
    if (fetching) return fetching;

    fetching = (async () => {
      const result = await client.provider.list();
      if (result.error || !result.data) {
        // Allow retry next time
        fetching = undefined;
        return undefined;
      }
      cachedData = result.data;
      return cachedData;
    })();

    return fetching;
  }

  return async (providerID: string, modelID: string): Promise<boolean> => {
    let data = await getData();
    if (!data) return false;

    // Check if the provider/model exists in the cached data
    const provider = data.all.find((p) => p.id === providerID);
    if (!provider || !(modelID in provider.models)) {
      // Cache miss: refetch once to handle newly-added providers
      data = await getData(true);
      if (!data) return false;
    }

    const p = data.all.find((e) => e.id === providerID);
    return p?.models[modelID]?.modalities?.input?.includes("image") ?? false;
  };
}
