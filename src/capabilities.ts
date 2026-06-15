export type ProviderListData = {
  all: Array<{
    id: string;
    models: Record<
      string,
      {
        modalities?: { input: string[]; output: string[] };
        capabilities?: { input?: { image?: boolean } };
      }
    >;
  }>;
  default: Record<string, string>;
  connected: string[];
};

export function supportsImageInput(
  data: ProviderListData,
  providerID: string,
  modelID: string,
): boolean {
  const provider = data.all.find((p) => p.id === providerID);
  const model = provider?.models[modelID];
  return model?.capabilities?.input?.image ?? model?.modalities?.input?.includes("image") ?? false;
}

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

    const provider = data.all.find((p) => p.id === providerID);
    if (!provider || !(modelID in provider.models)) {
      data = await getData(true);
      if (!data) return false;
    }

    return supportsImageInput(data, providerID, modelID);
  };
}
