export type RuntimeProfile = "development" | "test" | "production";

export type SecretProvider = "auto" | "env" | "config" | "kms" | "hsm";
export type SecretSource = Exclude<SecretProvider, "auto">;
export type ExternalSecretProvider = Extract<SecretSource, "kms" | "hsm">;

export type SecretAdapter = (args: {
  secretRef: string;
  env: NodeJS.ProcessEnv;
}) => string;

export type SecretAdapterRegistry = Partial<
  Record<ExternalSecretProvider, SecretAdapter>
>;

export interface ResolveSecretOptions {
  secretLabel: string;
  provider: SecretProvider;
  runtimeProfile: RuntimeProfile;
  envVarName: string;
  envValue?: string;
  configValue?: string;
  secretRef?: string;
  adapters?: SecretAdapterRegistry;
}

export interface ResolvedSecret {
  value: string;
  source: SecretSource;
  provider: SecretProvider;
  dualSource: boolean;
}

function normalize(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function requireValue(value: string | null, message: string): string {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function resolveFromExternalProvider(
  provider: ExternalSecretProvider,
  options: ResolveSecretOptions,
): string {
  const adapter = options.adapters?.[provider];
  if (!adapter) {
    throw new Error(
      `Secret provider "${provider}" selected for ${options.secretLabel}, but no adapter is configured`,
    );
  }
  const secretRef = requireValue(
    normalize(options.secretRef),
    `Missing ${options.secretLabel} secret reference for provider "${provider}"`,
  );
  return requireValue(
    normalize(adapter({ secretRef, env: process.env })),
    `Secret provider "${provider}" returned an empty value for ${options.secretLabel}`,
  );
}

export function resolveSecret(options: ResolveSecretOptions): ResolvedSecret {
  const envSecret = normalize(options.envValue);
  const configSecret = normalize(options.configValue);

  if (options.runtimeProfile === "production" && configSecret) {
    throw new Error(
      `Insecure secret source for ${options.secretLabel}: plaintext config secrets are not allowed when runtime_profile=production`,
    );
  }

  let source: SecretSource;
  let value: string;

  switch (options.provider) {
    case "auto":
      if (envSecret) {
        source = "env";
        value = envSecret;
      } else if (configSecret) {
        source = "config";
        value = configSecret;
      } else {
        throw new Error(
          `Missing ${options.secretLabel}: set ${options.envVarName} env var or configure plaintext value in config for non-production mode`,
        );
      }
      break;
    case "env":
      source = "env";
      value = requireValue(
        envSecret,
        `Missing ${options.secretLabel}: ${options.envVarName} is required when provider=env`,
      );
      break;
    case "config":
      source = "config";
      value = requireValue(
        configSecret,
        `Missing ${options.secretLabel} in config file when provider=config`,
      );
      break;
    case "kms":
    case "hsm":
      source = options.provider;
      value = resolveFromExternalProvider(options.provider, options);
      break;
  }

  if (options.runtimeProfile === "production" && source === "config") {
    throw new Error(
      `Insecure secret source for ${options.secretLabel}: plaintext config secrets are not allowed when runtime_profile=production`,
    );
  }

  return {
    value,
    source,
    provider: options.provider,
    dualSource: Boolean(envSecret && configSecret),
  };
}
