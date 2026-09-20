/**
 * Provider Setup (FR-023, FR-024, FR-025, FR-026, FR-038, FR-049, FR-087).
 *
 * Every choice offered here comes from the registries in `src/shared/registry`.
 * No provider and no model is named in this file, so adding one is a registry
 * edit rather than a UI edit (FR-037, ADR-022, TC-057).
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { LLM_REGISTRY } from '../../../shared/registry/llm.js';
import {
  backupConflict,
  latencyConsequence,
  sharedCredentialNotice,
} from '../../../shared/registry/selection.js';
import { STT_REGISTRY } from '../../../shared/registry/stt.js';
import type {
  CredentialId,
  HealthState,
  LlmModelDescriptor,
  LlmCatalogProvider,
  ProviderChoice,
  ProviderDescriptor,
  SecretStatus,
  Settings,
  SttModelDescriptor,
  SttCatalogSnapshot,
} from '../../../shared/types.js';
import { call } from '../call.js';
import type { ProvidersState } from '../state.js';

type Slot = 'stt-primary' | 'stt-backup' | 'llm-primary' | 'llm-backup';

interface Draft {
  stt: { primary: ProviderChoice; backup: ProviderChoice | null };
  llm: { primary: ProviderChoice; backup: ProviderChoice | null };
}

/** `checking` is a state the user can see, so a slow provider is not a blank UI. */
type KeyState =
  { kind: 'idle' } | { kind: 'checking' } | { kind: 'pass' } | { kind: 'fail'; reason: string };

function providerName<M>(registry: ProviderDescriptor<M>[], providerId: string): string {
  return registry.find((p) => p.id === providerId)?.displayName ?? providerId;
}

function modelsOf<M>(registry: ProviderDescriptor<M>[], providerId: string): M[] {
  return registry.find((p) => p.id === providerId)?.models ?? [];
}

/** Price per audio minute, written so a fraction of a cent is still readable. */
function sttPrice(model: SttModelDescriptor): string {
  if (model.priceKnown === false) return 'Price unavailable';
  return `$${model.pricePerAudioMinuteUsd.toFixed(4)} per audio minute`;
}

function llmPrice(model: LlmModelDescriptor): string {
  if (!model.pricing.known) return 'Price unavailable';
  return (
    `$${model.pricing.inputPerMTokUsd.toFixed(2)} per million input tokens, ` +
    `$${model.pricing.outputPerMTokUsd.toFixed(2)} per million output tokens`
  );
}

function healthText(state: HealthState): string {
  switch (state.kind) {
    case 'using-primary':
      return 'Using the primary.';
    case 'retrying':
      return `Retrying, attempt ${state.attempt}.`;
    case 'using-backup':
      return 'Failed over to the backup.';
    case 'degraded':
      return `Degraded. ${state.reason}`;
    case 'config-required':
      return `Needs configuration. ${state.reason}`;
  }
}

/**
 * How bad a health state is. Higher wins the shared badge (ADR-017).
 *
 * A comparison, not a special case for `using-primary`. Treating only
 * `using-primary` as "better" meant a credential that was failing over for one
 * capability and needed reconfiguring for the other showed the failover and
 * hid the one sentence that told the user what to fix.
 */
const HEALTH_SEVERITY: Record<HealthState['kind'], number> = {
  'using-primary': 0,
  retrying: 1,
  'using-backup': 2,
  degraded: 3,
  'config-required': 4,
};

/**
 * Which credential is paying for a capability right now (ADR-017).
 *
 * `config-required` names its own credential, so it is believed. Otherwise the
 * serving choice decides: a capability that has failed over is being served by
 * the backup's credential, and attributing its state to the primary's key would
 * point the user at a key that is working.
 */
function servingCredential<M>(
  state: HealthState,
  primary: ProviderChoice,
  backup: ProviderChoice | null,
  registry: ProviderDescriptor<M>[],
): CredentialId | undefined {
  if (state.kind === 'config-required') return state.credentialId;
  const choice = state.kind === 'using-backup' && backup ? backup : primary;
  return registry.find((p) => p.id === choice.providerId)?.credentialId;
}

/**
 * One badge per credential, never one per capability (ADR-017).
 *
 * Speech-to-text and the language model can be the same key. Two badges for one
 * credential would report the same outage twice and would let the user fix one
 * and think the other was a different problem.
 */
function healthByCredential(
  settings: Settings,
  providers: ProvidersState,
): { credentialId: CredentialId; capabilities: string[]; state: HealthState }[] {
  const entries: { credentialId: CredentialId; capability: string; state: HealthState }[] = [];
  const sttCredential = servingCredential(
    providers.stt,
    settings.providers.stt.primary,
    settings.providers.stt.backup,
    STT_REGISTRY,
  );
  const llmCredential = servingCredential(
    providers.llm,
    settings.providers.llm.primary,
    settings.providers.llm.backup,
    LLM_REGISTRY,
  );
  if (sttCredential) {
    entries.push({
      credentialId: sttCredential,
      capability: 'Speech to text',
      state: providers.stt,
    });
  }
  if (llmCredential) {
    entries.push({
      credentialId: llmCredential,
      capability: 'Language model',
      state: providers.llm,
    });
  }

  const grouped = new Map<
    CredentialId,
    { credentialId: CredentialId; capabilities: string[]; state: HealthState }
  >();
  for (const entry of entries) {
    const existing = grouped.get(entry.credentialId);
    if (!existing) {
      grouped.set(entry.credentialId, {
        credentialId: entry.credentialId,
        capabilities: [entry.capability],
        state: entry.state,
      });
      continue;
    }
    existing.capabilities.push(entry.capability);
    // The worse of the two wins the shared badge: a healthy language model does
    // not make a dead speech-to-text socket look fine.
    if (HEALTH_SEVERITY[entry.state.kind] > HEALTH_SEVERITY[existing.state.kind]) {
      existing.state = entry.state;
    }
  }
  return [...grouped.values()];
}

/**
 * A `CMP-15` message as a sentence (`CH-217`).
 *
 * The loop writes for the log, where a lowercase fragment is the convention, and
 * `CH-217` carries the same string to the screen rather than a second one that
 * could drift from it. Capitalizing here is the whole of the difference.
 */
function sentence(message: string): string {
  return message.charAt(0).toUpperCase() + message.slice(1);
}

export interface ProviderSetupProps {
  settings: Settings;
  secrets: SecretStatus | null;
  providers: ProvidersState | null;
  /** A live session binds the providers, as it binds the profile (ADR-013). */
  sessionActive: boolean;
  /**
   * A fault in the session now running, or null (`CH-217`, NFR-008).
   *
   * It sits here rather than beside the session controls because every fault
   * this channel carries is about a provider that could not be used, which is
   * what this panel is for. Unlike the health badges it is not keyed by
   * credential: a model missing from the registry and a key that was never
   * saved never reach a provider at all (ADR-024).
   */
  sessionNotice: string | null;
  onSettingsChanged: () => Promise<void>;
  onSecretsChanged: () => Promise<void>;
}

export function ProviderSetup({
  settings,
  secrets,
  providers,
  sessionActive,
  sessionNotice,
  onSettingsChanged,
  onSecretsChanged,
}: ProviderSetupProps): JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => ({
    stt: settings.providers.stt,
    llm: settings.providers.llm,
  }));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [keyStates, setKeyStates] = useState<Record<string, KeyState>>({});
  const [llmCatalog, setLlmCatalog] = useState<LlmCatalogProvider[] | null>(null);
  const [llmCatalogMessage, setLlmCatalogMessage] = useState('Loading models…');

  async function loadLlmCatalog(force = false): Promise<void> {
    setLlmCatalogMessage(force ? 'Refreshing models…' : 'Loading models…');
    const result = await call(force ? 'llmCatalog:refresh' : 'llmCatalog:get');
    if (!result.ok) {
      setLlmCatalogMessage(`Models could not be loaded. ${result.message}`);
      return;
    }
    setLlmCatalog(result.value.providers);
    const failures = result.value.providers.filter((provider) => provider.state !== 'ready');
    setLlmCatalogMessage(
      failures.length === 0
        ? 'Models are up to date.'
        : failures
            .map(
              (provider) =>
                `${provider.displayName}: ${provider.message ?? (provider.state === 'fallback' ? 'using fallback models' : provider.state)}`,
            )
            .join(' '),
    );
  }

  useEffect(() => {
    void loadLlmCatalog();
    return window.copilot.on('state:llmCatalog', (result) => {
      setLlmCatalog(result.providers);
      const failures = result.providers.filter((provider) => provider.state !== 'ready');
      setLlmCatalogMessage(
        failures.length === 0
          ? 'Models are up to date.'
          : failures
              .map(
                (provider) =>
                  `${provider.displayName}: ${provider.message ?? (provider.state === 'fallback' ? 'using fallback models' : provider.state)}`,
              )
              .join(' '),
      );
    });
  }, []);

  const [sttCatalog, setSttCatalog] = useState<SttCatalogSnapshot | null>(null);
  const [sttCatalogLoading, setSttCatalogLoading] = useState(true);
  const [sttCatalogError, setSttCatalogError] = useState<string | null>(null);
  const sttCatalogRequest = useRef(0);

  async function loadSttCatalog(force = false): Promise<void> {
    const request = ++sttCatalogRequest.current;
    setSttCatalogLoading(true);
    setSttCatalogError(null);
    const result = await call('catalog:stt', { force });
    if (request !== sttCatalogRequest.current) return;
    if (result.ok) setSttCatalog(result.value);
    else setSttCatalogError(result.message);
    setSttCatalogLoading(false);
  }
  useEffect(() => {
    void loadSttCatalog();
  }, []);

  const sttRegistry = useMemo<ProviderDescriptor<SttModelDescriptor>[]>(() => {
    if (!sttCatalog) return STT_REGISTRY;
    return STT_REGISTRY.map((provider) => {
      const runtime = sttCatalog.providers.find((entry) => entry.providerId === provider.id);
      const models = runtime?.models ? [...runtime.models] : [...provider.models];
      for (const choice of [draft.stt.primary, draft.stt.backup]) {
        if (
          choice?.providerId === provider.id &&
          !models.some((model) => model.id === choice.modelId)
        ) {
          const shipped = provider.models.find((model) => model.id === choice.modelId);
          if (shipped)
            models.push({ ...shipped, catalogStatus: 'unavailable', catalogSource: 'fallback' });
        }
      }
      return { ...provider, models };
    });
  }, [sttCatalog, draft.stt]);

  // The main process owns the settings, so a change made anywhere else has to
  // land here or Save would write a stale draft back. Keyed on the *value*, not
  // on the object: `config:get` answers with a fresh object every time, so any
  // other section saving anything at all reloaded the settings and wiped a
  // provider selection the user had not saved yet.
  const storedProviders = JSON.stringify(settings.providers);
  useEffect(() => {
    setDraft(JSON.parse(storedProviders) as Draft);
  }, [storedProviders]);

  const sttConflict = backupConflict(draft.stt.primary, draft.stt.backup, (id) =>
    providerName(sttRegistry, id),
  );
  const llmConflict = backupConflict(draft.llm.primary, draft.llm.backup, (id) =>
    providerName(LLM_REGISTRY, id),
  );

  const sttPrimaryModel = useMemo(
    () =>
      modelsOf(sttRegistry, draft.stt.primary.providerId).find(
        (m) => m.id === draft.stt.primary.modelId,
      ) ?? null,
    [draft.stt.primary, sttRegistry],
  );
  const sttBackupModel = useMemo(
    () =>
      draft.stt.backup
        ? (modelsOf(sttRegistry, draft.stt.backup.providerId).find(
            (m) => m.id === draft.stt.backup?.modelId,
          ) ?? null)
        : null,
    [draft.stt.backup, sttRegistry],
  );

  const consequences = [sttPrimaryModel, sttBackupModel]
    .filter((m): m is SttModelDescriptor => m !== null)
    .map((m) => latencyConsequence(m))
    .filter((text): text is string => text !== null);

  // A save during a live session is refused here, not merely discouraged.
  // `config:set` rebinds the health registry immediately while `CMP-15` keeps
  // the STT sockets it already opened on the old choice, so the badge would
  // report the new configuration while the audio still went to the old one, and
  // a later failure on an old socket would be raised into a machine bound to a
  // provider that had never been tried. Closing and reopening the pair
  // atomically is the session loop's to do; until it does, the safe answer is
  // that the providers are bound for the session, exactly as the profile is
  // (ADR-013).
  const blocked = sttConflict !== null || llmConflict !== null || sessionActive;

  function setSttChoice(which: 'primary' | 'backup', choice: ProviderChoice | null): void {
    setSaved(false);
    setDraft((current) => ({
      ...current,
      stt:
        which === 'primary'
          ? { ...current.stt, primary: choice ?? current.stt.primary }
          : { ...current.stt, backup: choice },
    }));
  }

  function setLlmChoice(which: 'primary' | 'backup', choice: ProviderChoice | null): void {
    setSaved(false);
    setDraft((current) => ({
      ...current,
      llm:
        which === 'primary'
          ? { ...current.llm, primary: choice ?? current.llm.primary }
          : { ...current.llm, backup: choice },
    }));
  }

  async function save(): Promise<void> {
    setSaveError(null);
    const result = await call('config:set', { providers: draft });
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    setSaved(true);
    await onSettingsChanged();
  }

  async function saveKey(credentialId: CredentialId): Promise<void> {
    const key = (keys[credentialId] ?? '').trim();
    if (key.length === 0) {
      setKeyStates((s) => ({
        ...s,
        [credentialId]: { kind: 'fail', reason: 'Enter a key first.' },
      }));
      return;
    }
    setKeyStates((s) => ({ ...s, [credentialId]: { kind: 'checking' } }));
    const result = await call('secrets:set', { provider: credentialId, key });
    if (!result.ok) {
      setKeyStates((s) => ({ ...s, [credentialId]: { kind: 'fail', reason: result.message } }));
      return;
    }
    setKeyStates((s) => ({
      ...s,
      [credentialId]: result.value.ok
        ? { kind: 'pass' }
        : { kind: 'fail', reason: result.value.reason ?? 'The provider refused the key.' },
    }));
    // Only a validated key is saved (FR-026), so the stored status is the truth
    // about what happened, whichever way the check went.
    if (result.value.ok) {
      setKeys((k) => ({ ...k, [credentialId]: '' }));
      if (STT_REGISTRY.some((provider) => provider.credentialId === credentialId)) {
        await loadSttCatalog(true);
      }
    }
    await onSecretsChanged();
  }

  const credentials = useMemo(() => {
    const seen = new Map<CredentialId, string[]>();
    for (const provider of [...STT_REGISTRY, ...LLM_REGISTRY]) {
      const names = seen.get(provider.credentialId) ?? [];
      if (!names.includes(provider.displayName)) names.push(provider.displayName);
      seen.set(provider.credentialId, names);
    }
    return [...seen.entries()];
  }, []);

  return (
    <section data-testid="section-provider-setup" aria-labelledby="provider-setup-heading">
      <h2 id="provider-setup-heading">Provider Setup</h2>

      <p data-testid="shared-credential-notice">{sharedCredentialNotice()}</p>

      {sessionNotice ? (
        <p role="alert" data-testid="session-notice">
          {sentence(sessionNotice)} The session is still running.
        </p>
      ) : null}

      {providers ? (
        <ul data-testid="provider-health" className="badges">
          {healthByCredential(settings, providers).map((badge) => (
            <li key={badge.credentialId} data-testid={`health-${badge.credentialId}`}>
              <strong>{badge.credentialId}</strong> ({badge.capabilities.join(' and ')}):{' '}
              {healthText(badge.state)}
            </li>
          ))}
        </ul>
      ) : null}

      <h3>Speech to text</h3>
      <button
        type="button"
        disabled={sttCatalogLoading || sessionActive}
        onClick={() => void loadSttCatalog(true)}
      >
        {sttCatalogLoading ? 'Loading models…' : 'Refresh models'}
      </button>
      {sttCatalogError ? <p role="alert">{sttCatalogError}</p> : null}
      {sttCatalog?.providers.map((provider) => (
        <p
          key={provider.providerId}
          role="status"
          data-testid={`catalog-state-${provider.providerId}`}
        >
          {provider.displayName}: {provider.state}
          {provider.lastSuccessfulRefresh
            ? ` — refreshed ${new Date(provider.lastSuccessfulRefresh).toLocaleString()}`
            : ''}
          {provider.message ? ` — ${provider.message}` : ''}
        </p>
      ))}
      <SttSlot
        slot="stt-primary"
        label="Primary"
        choice={draft.stt.primary}
        registry={sttRegistry}
        onChange={(choice) => setSttChoice('primary', choice)}
      />
      <SttSlot
        slot="stt-backup"
        label="Backup"
        choice={draft.stt.backup}
        registry={sttRegistry}
        optional
        onChange={(choice) => setSttChoice('backup', choice)}
      />
      {sttConflict ? (
        <p role="alert" data-testid="stt-backup-conflict">
          {sttConflict}
        </p>
      ) : null}

      <h3>Language model</h3>
      <button
        type="button"
        data-testid="refresh-llm-models"
        onClick={() => void loadLlmCatalog(true)}
      >
        Refresh models
      </button>
      <span role="status" data-testid="llm-catalog-state">
        {llmCatalogMessage}
      </span>
      {llmCatalog?.map((provider) =>
        provider.lastSuccessfulRefresh ? (
          <p key={provider.providerId}>
            {provider.displayName} last refreshed{' '}
            {new Date(provider.lastSuccessfulRefresh).toLocaleString()}.
          </p>
        ) : null,
      )}
      <LlmSlot
        slot="llm-primary"
        label="Primary"
        choice={draft.llm.primary}
        catalog={llmCatalog}
        onChange={(choice) => setLlmChoice('primary', choice)}
      />
      <LlmSlot
        slot="llm-backup"
        label="Backup"
        choice={draft.llm.backup}
        catalog={llmCatalog}
        optional
        onChange={(choice) => setLlmChoice('backup', choice)}
      />
      {llmConflict ? (
        <p role="alert" data-testid="llm-backup-conflict">
          {llmConflict}
        </p>
      ) : null}

      {consequences.length > 0 ? (
        <div role="status" data-testid="non-streaming-consequence">
          {consequences.map((text) => (
            <p key={text}>{text}</p>
          ))}
        </div>
      ) : null}

      {sessionActive ? (
        <p role="status" data-testid="providers-locked">
          A session is running. The speech-to-text and language model selections are bound for the
          whole session, so they cannot be changed until it stops.
        </p>
      ) : null}

      <button
        type="button"
        data-testid="save-providers"
        disabled={blocked}
        onClick={() => void save()}
      >
        Save provider selection
      </button>
      {saved ? <span data-testid="providers-saved">Saved</span> : null}
      {saveError ? (
        <span role="alert" data-testid="providers-save-failed">
          {saveError}
        </span>
      ) : null}

      <h3>API keys</h3>
      <p>
        A key is checked against its provider before it is saved. A key that fails the check is
        never saved.
      </p>
      <ul className="rows">
        {credentials.map(([credentialId, names]) => {
          const state = keyStates[credentialId] ?? { kind: 'idle' };
          return (
            <li key={credentialId}>
              <label htmlFor={`key-${credentialId}`}>
                {names.join(' and ')} key
                {secrets === null
                  ? ' (whether a key is saved could not be read)'
                  : secrets[credentialId]
                    ? ' (saved)'
                    : ' (not saved)'}
              </label>
              <input
                id={`key-${credentialId}`}
                data-testid={`key-input-${credentialId}`}
                type="password"
                autoComplete="off"
                // Locked while the check runs, for the same reason the button
                // is. `FR-026` allows the check 10 seconds, and a key that
                // passes clears the field: a replacement typed inside that
                // window was wiped by an answer about the *previous* key, and
                // the verdict that landed beside the empty field said "Key
                // accepted and saved" about a value the vault had never seen.
                // That is the defect the `onChange` reset below was added to
                // prevent, arriving by the asynchronous path instead.
                disabled={state.kind === 'checking'}
                value={keys[credentialId] ?? ''}
                onChange={(e) => {
                  setKeys((k) => ({ ...k, [credentialId]: e.target.value }));
                  // The verdict belonged to the key that was checked. A passing
                  // key clears the field, so typing a replacement left "Key
                  // accepted and saved" beside a value the vault has never
                  // seen, which reads as though it were already stored.
                  setKeyStates((st) => ({ ...st, [credentialId]: { kind: 'idle' } }));
                }}
              />
              <button
                type="button"
                data-testid={`key-save-${credentialId}`}
                disabled={state.kind === 'checking'}
                onClick={() => void saveKey(credentialId)}
              >
                Check and save
              </button>
              <span role="status" data-testid={`key-state-${credentialId}`}>
                {state.kind === 'idle' ? '' : null}
                {state.kind === 'checking' ? 'Checking the key with the provider…' : null}
                {state.kind === 'pass' ? 'Key accepted and saved.' : null}
                {state.kind === 'fail' ? `Key refused and not saved. ${state.reason}` : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface SlotProps<C> {
  slot: Slot;
  label: string;
  choice: C;
  optional?: boolean;
  onChange: (choice: ProviderChoice | null) => void;
}

function SttSlot({
  slot,
  label,
  choice,
  optional,
  onChange,
  registry,
}: SlotProps<ProviderChoice | null> & {
  registry: ProviderDescriptor<SttModelDescriptor>[];
}): JSX.Element {
  const providerId = choice?.providerId ?? '';
  const models = providerId ? modelsOf(registry, providerId) : [];
  return (
    <div className="slot" data-testid={`slot-${slot}`}>
      <label htmlFor={`${slot}-provider`}>{label} provider</label>
      <select
        id={`${slot}-provider`}
        data-testid={`${slot}-provider`}
        value={providerId}
        onChange={(e) => {
          const nextProvider = e.target.value;
          if (nextProvider === '') return onChange(null);
          const first = modelsOf(registry, nextProvider)[0];
          onChange(first ? { providerId: nextProvider, modelId: first.id } : null);
        }}
      >
        {optional ? <option value="">None</option> : null}
        {registry.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.displayName}
          </option>
        ))}
      </select>

      <label htmlFor={`${slot}-model`}>{label} model</label>
      <select
        id={`${slot}-model`}
        data-testid={`${slot}-model`}
        value={choice?.modelId ?? ''}
        disabled={providerId === ''}
        onChange={(e) => onChange({ providerId, modelId: e.target.value })}
      >
        {choice && !models.some((model) => model.id === choice.modelId) ? (
          <option value={choice.modelId}>{choice.modelId} (unavailable)</option>
        ) : null}
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.displayName}
            {model.catalogStatus && model.catalogStatus !== 'available'
              ? ` (${model.catalogStatus})`
              : ''}{' '}
            — {model.streaming ? 'streams' : 'does not stream'} — {sttPrice(model)}
          </option>
        ))}
      </select>

      <table data-testid={`${slot}-model-table`}>
        <caption>Models offered by this provider</caption>
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Streams</th>
            <th scope="col">Price</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={model.id} data-testid={`${slot}-model-row-${model.id}`}>
              <td>{model.displayName}</td>
              <td>{model.streaming ? 'Yes' : 'No'}</td>
              <td>{sttPrice(model)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LlmSlot({
  slot,
  label,
  choice,
  optional,
  onChange,
  catalog,
}: SlotProps<ProviderChoice | null> & { catalog: LlmCatalogProvider[] | null }): JSX.Element {
  const providerId = choice?.providerId ?? '';
  const catalogProviders =
    catalog ??
    LLM_REGISTRY.map((provider) => ({
      providerId: provider.id,
      displayName: provider.displayName,
      models: provider.models,
    }));
  const models = providerId
    ? (catalogProviders.find((provider) => provider.providerId === providerId)?.models ?? [])
    : [];
  const selected = models.find((model) => model.id === choice?.modelId);
  return (
    <div className="slot" data-testid={`slot-${slot}`}>
      <label htmlFor={`${slot}-provider`}>{label} provider</label>
      <select
        id={`${slot}-provider`}
        data-testid={`${slot}-provider`}
        value={providerId}
        onChange={(e) => {
          const nextProvider = e.target.value;
          if (nextProvider === '') return onChange(null);
          const nextModels =
            catalogProviders.find((provider) => provider.providerId === nextProvider)?.models ?? [];
          const first = nextModels.find((model) => model.status === 'available') ?? nextModels[0];
          onChange(first ? { providerId: nextProvider, modelId: first.id } : null);
        }}
      >
        {optional ? <option value="">None</option> : null}
        {catalogProviders.map((provider) => (
          <option key={provider.providerId} value={provider.providerId}>
            {provider.displayName}
          </option>
        ))}
      </select>

      <label htmlFor={`${slot}-model`}>{label} model</label>
      <select
        id={`${slot}-model`}
        data-testid={`${slot}-model`}
        value={choice?.modelId ?? ''}
        disabled={providerId === ''}
        onChange={(e) => onChange({ providerId, modelId: e.target.value })}
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.displayName}
            {model.status === 'available' ? '' : ` (${model.status})`} — streams — {llmPrice(model)}
          </option>
        ))}
      </select>

      {selected?.effort ? (
        <>
          <label htmlFor={`${slot}-effort`}>{label} reasoning effort</label>
          <select
            id={`${slot}-effort`}
            data-testid={`${slot}-effort`}
            value={
              selected.effort.allowed.includes(choice?.effort ?? '')
                ? choice?.effort
                : selected.effort.default
            }
            onChange={(event) => choice && onChange({ ...choice, effort: event.target.value })}
          >
            {selected.effort.allowed.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </>
      ) : null}

      <table data-testid={`${slot}-model-table`}>
        <caption>Models offered by this provider</caption>
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Streams</th>
            <th scope="col">Price</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={model.id} data-testid={`${slot}-model-row-${model.id}`}>
              <td>{model.displayName}</td>
              <td>Yes</td>
              <td>{llmPrice(model)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
