/**
 * Telling two bots apart.
 *
 * One composed row of this plugin serves one Lark app. A deployment that wants
 * a second bot composes a second row — and then three identifiers that were
 * constants have to stop being constants, or the two rows write over each
 * other: the durable store holding their workspace and model maps, the
 * credential holding their app secret, and the session ids their conversations
 * derive. The last one bites hardest and quietest: two bots invited to the SAME
 * group would otherwise derive one session id and share one agent.
 *
 * A row with no name keeps the ORIGINAL identifiers, byte for byte. That is
 * the whole compatibility story: an existing deployment names nothing, so its
 * credential and every stored session id stay exactly where they were, and its
 * settings section — imported into the profile row's config by the host, and
 * read back from there as a legacy seed — still names the same conversations.
 * Naming instances is something only a second bot needs.
 * @module @nextnowlabs/dsh-lark/instance
 */

/** What an instance name may contain: a lowercase, filename-safe token. */
const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** The settings section, credential, and session ids one row owns. */
export interface InstanceIdentity {
  /** The name itself, absent for the original single-row deployment. */
  readonly name?: string | undefined
  /**
   * User-settings namespace holding this row's durable state — the key an
   * upgraded deployment's legacy settings section arrives under, and the
   * human-facing name of what is now a storage domain.
   */
  readonly settingsNamespace: string
  /**
   * The storage domain (and backend unit) holding this row's durable state.
   *
   * Not the same string as {@link settingsNamespace}: a domain name doubles as
   * a file name and a backend identifier, so it admits only `[a-z0-9_]` — the
   * dash this plugin's own names are spelled with is folded to an underscore.
   */
  readonly stateDomain: string
  /** Credential reference holding this row's app secret. */
  readonly secretRef: string
  /** Prefix every session id of this row's conversations carries. */
  readonly sessionPrefix: string
}

/**
 * Reject a name that cannot safely become part of the three identifiers.
 * @param name - the configured instance name.
 * @returns why it is unusable, or undefined when it is fine.
 */
export function refuseInstanceName(name: string): string | undefined {
  return INSTANCE_PATTERN.test(name)
    ? undefined
    : `instance "${name}" must be 1-32 characters of a-z, 0-9 and dashes, starting with a letter or digit`
}

/**
 * Derive one row's identifiers.
 * @param name - the configured instance name; absent or empty is the original row.
 * @returns the identity to key settings, credentials, and sessions by.
 * @throws {Error} when a name is given that cannot be used.
 */
export function instanceIdentity(name?: string): InstanceIdentity {
  if (name === undefined || name === '') {
    return {
      settingsNamespace: 'lark-channel',
      stateDomain: 'lark_channel',
      secretRef: 'LARK_APP_SECRET',
      sessionPrefix: 'lark-',
    }
  }
  const refusal = refuseInstanceName(name)
  if (refusal !== undefined) throw new Error(`lark-channel: ${refusal}`)
  return {
    name,
    settingsNamespace: `lark-channel-${name}`,
    stateDomain: `lark_channel_${name.replace(/-/g, '_')}`,
    // A credential reference is a shell identifier, so the name is folded to
    // the case and separator that shape allows.
    secretRef: `LARK_APP_SECRET_${name.replace(/-/g, '_').toUpperCase()}`,
    sessionPrefix: `lark-${name}-`,
  }
}
