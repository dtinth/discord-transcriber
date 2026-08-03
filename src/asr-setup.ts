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
/**
 * How much audio a reused qwen-omni connection may accumulate before it is
 * retired. vxasr defaults to 180 s; this bot uses less because the vendor
 * re-processes prior turns as context, so a long-lived connection gets steadily
 * more expensive per utterance. An operator can still override it.
 */
const DEFAULT_STICKY_MAX_AUDIO_SECONDS = "100";

export function loadAsrSetup(raw: string, env: ProviderEnv): AsrSetup {
  // vxasr reads provider settings out of the env it is given, so defaults are
  // applied by layering here rather than by mutating `process.env`.
  env = {
    ...env,
    QWEN_OMNI_STICKY_MAX_AUDIO_SECONDS:
      env.QWEN_OMNI_STICKY_MAX_AUDIO_SECONDS ?? DEFAULT_STICKY_MAX_AUDIO_SECONDS,
  };

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
