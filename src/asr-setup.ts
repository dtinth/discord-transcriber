import {
  createDefaultConfigurationCatalogue,
  type ConfigurationDefinition,
  type ProviderEnv,
} from "vxasr";

export interface AsrSetup {
  /** Ordered list; the transcription job rotates through it on retry. */
  configurations: readonly ConfigurationDefinition[];
  env: ProviderEnv;
}

/**
 * Parses `ASR_CONFIGURATIONS` (a comma-separated list of vxasr configuration
 * ids, in retry order) and validates every entry against the catalogue and
 * the environment's credentials. Throws with an actionable message on any
 * problem — this runs at startup, where failing loudly beats failing on the
 * first utterance.
 */
export function loadAsrSetup(raw: string, env: ProviderEnv): AsrSetup {
  const catalogue = createDefaultConfigurationCatalogue();
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  if (ids.length === 0) {
    throw new Error(
      `ASR_CONFIGURATIONS is empty. Available: ${catalogue.ids.join(", ")}`
    );
  }

  const configurations = ids.map((id) => {
    const definition = catalogue.get(id);
    if (!definition) {
      throw new Error(
        `Unknown ASR configuration "${id}". Available: ${catalogue.ids.join(", ")}`
      );
    }
    const missing = definition.missingConfig(env);
    if (missing.length > 0) {
      throw new Error(
        `ASR configuration "${id}" needs environment variables: ${missing.join(", ")}`
      );
    }
    return definition;
  });

  return { configurations, env };
}
