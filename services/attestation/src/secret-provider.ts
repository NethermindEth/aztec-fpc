export type RuntimeProfile = "development" | "test" | "production";

export type SecretProvider = "auto" | "env" | "config" | "kms" | "hsm";
export type SecretSource = Exclude<SecretProvider, "auto">;
export type ExternalSecretProvider = Extract<SecretSource, "kms" | "hsm">;

export type SecretAdapter = (args: { secretRef: string; env: NodeJS.ProcessEnv }) => string;

export type SecretAdapterRegistry = Partial<Record<ExternalSecretProvider, SecretAdapter>>;

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

function assertNoPlaintextConfigSecret(
  runtimeProfile: RuntimeProfile,
  configSecret: string | null,
  secretLabel: string,
): void {
  if (runtimeProfile !== "production" || !configSecret) {
    return;
  }
  throw new Error(
    `Insecure secret source for ${secretLabel}: plaintext config secrets are not allowed when runtime_profile=production`,
  );
}

function assertNoPlaintextConfigSource(
  runtimeProfile: RuntimeProfile,
  source: SecretSource,
  secretLabel: string,
) {
  if (runtimeProfile !== "production" || source !== "config") {
    return;
  }
  throw new Error(
    `Insecure secret source for ${secretLabel}: plaintext config secrets are not allowed when runtime_profile=production`,
  );
}

function resolveAutoSecret(
  envSecret: string | null,
  configSecret: string | null,
  options: ResolveSecretOptions,
): { source: SecretSource; value: string } {
  if (envSecret) {
    return { source: "env", value: envSecret };
  }
  if (configSecret) {
    return { source: "config", value: configSecret };
  }
  throw new Error(
    `Missing ${options.secretLabel}: set ${options.envVarName} env var or configure plaintext value in config for non-production mode`,
  );
}

function resolveProviderSecret(
  provider: SecretProvider,
  envSecret: string | null,
  configSecret: string | null,
  options: ResolveSecretOptions,
): { source: SecretSource; value: string } {
  switch (provider) {
    case "auto":
      return resolveAutoSecret(envSecret, configSecret, options);
    case "env":
      return {
        source: "env",
        value: requireValue(
          envSecret,
          `Missing ${options.secretLabel}: ${options.envVarName} is required when provider=env`,
        ),
      };
    case "config":
      return {
        source: "config",
        value: requireValue(
          configSecret,
          `Missing ${options.secretLabel} in config file when provider=config`,
        ),
      };
    case "kms":
    case "hsm":
      return {
        source: provider,
        value: resolveFromExternalProvider(provider, options),
      };
  }
}

export function resolveSecret(options: ResolveSecretOptions): ResolvedSecret {
  const envSecret = normalize(options.envValue);
  const configSecret = normalize(options.configValue);
  assertNoPlaintextConfigSecret(options.runtimeProfile, configSecret, options.secretLabel);
  const { source, value } = resolveProviderSecret(
    options.provider,
    envSecret,
    configSecret,
    options,
  );
  assertNoPlaintextConfigSource(options.runtimeProfile, source, options.secretLabel);

  return {
    value,
    source,
    provider: options.provider,
    dualSource: Boolean(envSecret && configSecret),
  };
}
